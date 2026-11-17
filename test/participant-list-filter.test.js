const assert = require('node:assert/strict');
const test = require('node:test');
const { buildParticipantListFilter } = require('../src/services/participantListFilter');

test('active participant filters bind one value per SQL placeholder', () => {
  const { where, params } = buildParticipantListFilter('ada', '', false);

  assert.match(where, /^archived_at IS NULL/);
  assert.equal((where.match(/\?/g) || []).length, params.length);
  assert.deepEqual(params, ['%ada%', '%ada%', '%ada%']);
});

test('archived and type filters bind every SQL placeholder', () => {
  const { where, params } = buildParticipantListFilter('ada', 'faculty', true);

  assert.match(where, /^archived_at IS NOT NULL/);
  assert.equal((where.match(/\?/g) || []).length, params.length);
  assert.deepEqual(params, ['%ada%', '%ada%', '%ada%', 'faculty']);
});
