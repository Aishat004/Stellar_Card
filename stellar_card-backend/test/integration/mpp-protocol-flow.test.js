// End-to-end integration test suite for the MPP challenge + card issuance
// flow under high concurrency (#1014).
//
// Simulates 10 concurrent AI agents each requesting a challenge,
// submitting a stubbed payment proof, and receiving a unique virtual card.
// Asserts:
//   - Each agent receives a unique challenge nonce.
//   - Each proof verification succeeds independently.
//   - Each agent receives a card with the correct fields.
//   - Zero race conditions or database-lock errors across all 10 runs.

require('../helpers/env');
process.env.MPP_SYNC_WAIT_MS = '1500';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { xdr, Address, nativeToScVal, Keypair, StrKey } = require('@stellar/stellar-sdk');

process.env.RECEIVER_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));

const { request, db } = require('../helpers/app');
const verifyModule = require('../../src/mpp/verify');

// ── Stubs ────────────────────────────────────────────────────────────────────

const STUB_CARD = {
  number: '4111111111110000',
  cvv: '001',
  expiry: '12/27',
  brand: 'USD Visa Card',
};

function makeContractEvent({ contractId, orderId, from, amount = 1_000_000n }) {
  const topics = [
    xdr.ScVal.scvSymbol('pay_usdc'),
    nativeToScVal(Buffer.from(orderId, 'utf-8'), { type: 'bytes' }),
    new Address(from).toScVal(),
  ];
  const data = nativeToScVal(amount, { type: 'i128' });
  const contractIdBuf = StrKey.decodeContract(contractId);
  return {
    contractId: () => contractIdBuf,
    body: () => ({ v0: () => ({ topics: () => topics, data: () => data }) }),
  };
}

function mockUsdcTx({ challengeId, amount, receiverContract }) {
  return {
    status: 'SUCCESS',
    ledger: 1_234_567,
    createdAt: 1_700_000_000,
    events: {
      contractEventsXdr: [
        makeContractEvent({
          contractId: receiverContract,
          orderId: challengeId,
          from: Keypair.random().publicKey(),
          amount: decimalToStroops(amount),
        }),
      ],
    },
  };
}

function decimalToStroops(decimal) {
  const [whole, frac = ''] = decimal.split('.');
  return BigInt(whole) * 10_000_000n + BigInt(frac.padEnd(7, '0'));
}

/** Fast fulfillment stub — marks order delivered with a fake card. */
async function stubHandlePayment({ orderId, txid }) {
  db.prepare(
    `UPDATE orders
        SET status = 'delivered',
            stellar_txid = @txid,
            card_number = @num,
            card_cvv = @cvv,
            card_expiry = @exp,
            card_brand = @brand
      WHERE id = @id`,
  ).run({
    id: orderId,
    txid,
    num: STUB_CARD.number,
    cvv: STUB_CARD.cvv,
    exp: STUB_CARD.expiry,
    brand: STUB_CARD.brand,
  });
}

function makeRpcStub(txMap) {
  return {
    getTransaction: async (hash) => txMap[hash] ?? { status: 'NOT_FOUND' },
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  db.prepare(`DELETE FROM mpp_challenges`).run();
  db.prepare(`DELETE FROM orders WHERE source = 'mpp'`).run();
  verifyModule._setRpcServer(null);
  verifyModule._setHandlePayment(null);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getChallenge(amount) {
  const res = await request.get(`/v1/cards/visa/${amount}`);
  assert.equal(res.status, 402);
  return res.body;
}

async function runAgentFlow({ agentIndex, receiverContract, txMap }) {
  // 1. Each agent requests a fresh challenge.
  const challenge = await getChallenge('10.00');
  assert.ok(challenge.challengeId, `agent ${agentIndex}: missing challengeId`);
  assert.ok(challenge.payTo, `agent ${agentIndex}: missing payTo`);

  // 2. Build a stubbed Stellar tx for this challenge.
  const fakeTxHash = `fake-tx-${agentIndex}-${challenge.challengeId}`;
  txMap[fakeTxHash] = mockUsdcTx({
    challengeId: challenge.challengeId,
    amount: '10.00',
    receiverContract,
  });

  // 3. Submit proof.
  const proofRes = await request
    .post('/v1/mpp/verify')
    .send({ challengeId: challenge.challengeId, txHash: fakeTxHash });

  assert.equal(proofRes.status, 200, `agent ${agentIndex}: verify failed — ${JSON.stringify(proofRes.body)}`);
  const { card } = proofRes.body;
  assert.ok(card, `agent ${agentIndex}: no card in response`);
  assert.equal(card.number, STUB_CARD.number, `agent ${agentIndex}: wrong card number`);
  assert.equal(card.cvv, STUB_CARD.cvv, `agent ${agentIndex}: wrong CVV`);
  assert.equal(card.expiry, STUB_CARD.expiry, `agent ${agentIndex}: wrong expiry`);

  return challenge.challengeId;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MPP protocol flow — 10 concurrent agents (#1014)', () => {
  it('issues unique challenges and delivers cards to all 10 agents in parallel', async () => {
    const receiverContract = process.env.RECEIVER_CONTRACT_ID;
    const txMap = {};
    const rpcStub = makeRpcStub(txMap);

    verifyModule._setRpcServer(rpcStub);
    verifyModule._setHandlePayment(stubHandlePayment);

    const AGENT_COUNT = 10;
    const results = await Promise.allSettled(
      Array.from({ length: AGENT_COUNT }, (_, i) =>
        runAgentFlow({ agentIndex: i, receiverContract, txMap }),
      ),
    );

    // All agents must succeed.
    const failures = results.filter((r) => r.status === 'rejected');
    assert.equal(
      failures.length,
      0,
      `${failures.length} agent(s) failed:\n` +
        failures.map((f) => f.reason?.message ?? String(f.reason)).join('\n'),
    );

    // All challenge IDs must be distinct.
    const challengeIds = results.map((r) => r.value);
    const unique = new Set(challengeIds);
    assert.equal(
      unique.size,
      AGENT_COUNT,
      `Expected ${AGENT_COUNT} unique challenge IDs, got ${unique.size}`,
    );
  });

  it('leaves no unredeemed challenges in the database after all agents complete', async () => {
    const receiverContract = process.env.RECEIVER_CONTRACT_ID;
    const txMap = {};
    const rpcStub = makeRpcStub(txMap);

    verifyModule._setRpcServer(rpcStub);
    verifyModule._setHandlePayment(stubHandlePayment);

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        runAgentFlow({ agentIndex: i, receiverContract, txMap }),
      ),
    );

    // All challenges must be in a terminal state (redeemed), not open.
    const open = db
      .prepare(`SELECT COUNT(*) as n FROM mpp_challenges WHERE redeemed_at IS NULL`)
      .get();
    assert.equal(open.n, 0, `${open.n} challenge(s) still open after all agents completed`);
  });

  it('rejects a replayed proof from any agent', async () => {
    const receiverContract = process.env.RECEIVER_CONTRACT_ID;
    const txMap = {};
    const rpcStub = makeRpcStub(txMap);

    verifyModule._setRpcServer(rpcStub);
    verifyModule._setHandlePayment(stubHandlePayment);

    // Use only 1 agent for the replay test — the replay guard is per-challenge.
    const challenge = await getChallenge('10.00');
    const fakeTxHash = `replay-tx-${challenge.challengeId}`;
    txMap[fakeTxHash] = mockUsdcTx({
      challengeId: challenge.challengeId,
      amount: '10.00',
      receiverContract,
    });

    // First submission succeeds.
    const first = await request
      .post('/v1/mpp/verify')
      .send({ challengeId: challenge.challengeId, txHash: fakeTxHash });
    assert.equal(first.status, 200);

    // Replay must be rejected.
    const replay = await request
      .post('/v1/mpp/verify')
      .send({ challengeId: challenge.challengeId, txHash: fakeTxHash });
    assert.ok(
      replay.status === 409 || replay.status === 400,
      `replay should be 409/400, got ${replay.status}`,
    );
  });
});
