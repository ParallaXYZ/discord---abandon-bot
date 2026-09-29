const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const context = vm.createContext({ console });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../abandon_bot.js'), 'utf8')
  .replace('export default {', 'const worker = {'), context);
const { parseRSS, getProductionNewDeals, steamDiscountIdentity } = context;
const deal = { id: 'steam_1057090_2026-10-01', store: 'steam', type: 'discount', expires: '2026-10-01' };

function mockKV(entries, pageSize = 100) {
  return {
    async get(key) { return entries[key] || null; },
    async list({ prefix, cursor }) {
      const keys = Object.keys(entries).filter(key => key.startsWith(prefix));
      const start = Number(cursor || 0);
      const end = start + pageSize;
      return { keys: keys.slice(start, end).map(name => ({ name })), list_complete: end >= keys.length, cursor: String(end) };
    }
  };
}

test('RSS variants produce the same normalized ID', () => {
  const xml = '<rss>' + ['steam_1057090_1October', 'steam_1057090_TIMESTAMP1790874000'].map(id =>
    `<item><title>Ori (-80%)</title><guid>${id}</guid><link>https://store.steampowered.com/app/1057090/</link><category>Steam Game</category><description><![CDATA[<p><strong>Price:</strong>€5.99 <s>€29.99</s> (-80%)</p><p><strong>Expires:</strong>2026-10-01</p>]]></description></item>`
  ).join('') + '</rss>';
  const parsed = parseRSS(xml, 'discount');
  assert.equal(parsed.length, 2);
  for (const item of parsed) {
    assert.equal(item.id, deal.id);
    assert.equal(item.price, '€5.99');
    assert.equal(item.originalPrice, '€29.99');
  }
});

for (const oldId of ['steam_1057090_1October', 'steam_1057090_TIMESTAMP1790874000']) {
  test(`previously published ${oldId} is suppressed`, async () => {
    const kv = mockKV({ [`seen:${oldId}`]: JSON.stringify({ ...deal, id: oldId }) });
    assert.equal((await getProductionNewDeals([deal], kv)).length, 0);
  });
}

test('history scan follows pagination and ignores invalid records', async () => {
  const kv = mockKV({
    'seen:steam_1057090_bad': 'invalid json',
    'seen:steam_1057090_null': 'null',
    'seen:steam_1057090_old': JSON.stringify({ ...deal, expires: '2026-09-01' }),
    'seen:steam_1057090_1October': JSON.stringify(deal)
  }, 1);
  assert.equal((await getProductionNewDeals([deal], kv)).length, 0);
});

test('a later sale is eligible, and a different game does not suppress it', async () => {
  const kv = mockKV({
    'seen:steam_1057090_1September': JSON.stringify({ ...deal, expires: '2026-09-01' }),
    'seen:steam_999_1October': JSON.stringify({ ...deal, id: 'steam_999_1October' })
  });
  assert.equal((await getProductionNewDeals([deal], kv)).length, 1);
});

test('canonical key avoids scanning legacy history', async () => {
  const kv = { async get() { return '{}'; }, async list() { throw Error('Unexpected list'); } };
  assert.equal((await getProductionNewDeals([deal], kv)).length, 0);
});

test('other deal types retain their original deduplication', async () => {
  for (const item of [
    { ...deal, type: 'free_weekend', id: 'steam_fw_1057090_x' },
    { ...deal, type: 'free_game' },
    { ...deal, store: 'epic', id: 'epic_game' }
  ]) {
    assert.equal(steamDiscountIdentity(item), null);
    const kv = { async get() { return null; }, async list() { throw Error('Unexpected list'); } };
    assert.equal((await getProductionNewDeals([item], kv)).length, 1);
  }
});

test('missing or invalid expiry preserves source ID; timestamp can supply expiry', () => {
  assert.equal(steamDiscountIdentity({ ...deal, id: 'steam_1057090_unknown', expires: '' }), null);
  assert.equal(steamDiscountIdentity({ ...deal, id: 'steam_1057090_unknown', expires: '2026-02-30' }), null);
  assert.equal(steamDiscountIdentity({ ...deal, id: 'steam_1057090_TIMESTAMP1790874000', expires: '' }).id, deal.id);
});
