import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractConsumptionFields,
  parseBncrMarker,
} from '../../src/messaging/outbound/marker-parser.ts';

test('parseBncrMarker: no marker returns original text', () => {
  const result = parseBncrMarker('hello world');
  assert.equal(result.cleanText, 'hello world');
  assert.deepEqual(result.params, {});
});

test('parseBncrMarker: standard marker with valid JSON', () => {
  const result = parseBncrMarker(
    'hello [BncrParam:{"forceDocument":true,"customKey":"val"}] world',
  );
  assert.equal(result.cleanText, 'hello world');
  assert.deepEqual(result.params, { forceDocument: true, customKey: 'val' });
});

test('parseBncrMarker: marker at start of text', () => {
  const result = parseBncrMarker('[BncrParam:{"asVoice":true}] speak this');
  assert.equal(result.cleanText, 'speak this');
  assert.deepEqual(result.params, { asVoice: true });
});

test('parseBncrMarker: marker at end of text', () => {
  const result = parseBncrMarker('upload [BncrParam:{"forceDocument":true}]');
  assert.equal(result.cleanText, 'upload');
  assert.deepEqual(result.params, { forceDocument: true });
});

test('parseBncrMarker: only marker, no visible text', () => {
  const result = parseBncrMarker('[BncrParam:{"forceDocument":true}]');
  assert.equal(result.cleanText, '');
  assert.deepEqual(result.params, { forceDocument: true });
});

test('parseBncrMarker: invalid JSON leaves marker in text for debugging', () => {
  const result = parseBncrMarker('bad [BncrParam:{invalid}] json');
  // Invalid JSON → marker stays in text so user can debug
  assert.equal(result.cleanText, 'bad [BncrParam:{invalid}] json');
  assert.deepEqual(result.params, {});
});

test('parseBncrMarker: empty JSON object', () => {
  const result = parseBncrMarker('empty [BncrParam:{}] marker');
  assert.equal(result.cleanText, 'empty marker');
  assert.deepEqual(result.params, {});
});

test('parseBncrMarker: JSON array with brackets gets partial match', () => {
  const result = parseBncrMarker('array [BncrParam:[1,2,3]] marker');
  assert.equal(result.cleanText, 'array [BncrParam:[1,2,3]] marker');
  assert.deepEqual(result.params, {});
});

test('parseBncrMarker: incomplete marker (missing closing bracket) left unchanged', () => {
  const result = parseBncrMarker('broken [BncrParam:{"key":"val"} still here');
  assert.equal(result.cleanText, 'broken [BncrParam:{"key":"val"} still here');
  assert.deepEqual(result.params, {});
});

test('extractConsumptionFields: undefined returns empty', () => {
  const { consumed, remaining } = extractConsumptionFields(undefined);
  assert.deepEqual(consumed, {});
  assert.deepEqual(remaining, {});
});

test('extractConsumptionFields: empty object returns empty', () => {
  const { consumed, remaining } = extractConsumptionFields({});
  assert.deepEqual(consumed, {});
  assert.deepEqual(remaining, {});
});

test('extractConsumptionFields: splits consumption vs remaining', () => {
  const { consumed, remaining } = extractConsumptionFields({
    asVoice: true,
    type: 'file',
    forceDocument: true,
    gifPlayback: false,
    customKey: 'val',
  });

  assert.equal(consumed.asVoice, true);
  assert.equal(consumed.type, 'file');
  assert.equal(consumed.forceDocument, undefined);
  assert.equal(remaining.forceDocument, true);
  assert.equal(remaining.gifPlayback, false);
  assert.equal(remaining.customKey, 'val');
});

test('extractConsumptionFields: all consumption fields identified', () => {
  const { consumed, remaining } = extractConsumptionFields({
    asVoice: true,
    audioAsVoice: true,
    type: 'image',
    kind: 'final',
    replyToId: '123',
  });

  assert.equal(consumed.asVoice, true);
  assert.equal(consumed.audioAsVoice, true);
  assert.equal(consumed.type, 'image');
  assert.equal(consumed.kind, 'final');
  assert.equal(consumed.replyToId, '123');
  assert.deepEqual(remaining, {});
});

test('extractConsumptionFields: keeps non-consumption fields intact', () => {
  const { consumed, remaining } = extractConsumptionFields({
    forceDocument: true,
    gifPlayback: true,
    silent: false,
    unknownField: 'hello',
  });

  assert.deepEqual(consumed, {});
  assert.equal(remaining.forceDocument, true);
  assert.equal(remaining.gifPlayback, true);
  assert.equal(remaining.silent, false);
  assert.equal(remaining.unknownField, 'hello');
});

test('extractConsumptionFields includes downloadMedia', () => {
  const { consumed, remaining } = extractConsumptionFields({
    downloadMedia: true,
    asVoice: true,
    unknownKey: 'val',
  });
  assert.equal(consumed.downloadMedia, true);
  assert.equal(consumed.asVoice, true);
  assert.deepEqual(remaining, { unknownKey: 'val' });
});

test('extractConsumptionFields no extra returns empty', () => {
  const { consumed, remaining } = extractConsumptionFields(undefined);
  assert.deepEqual(consumed, {});
  assert.deepEqual(remaining, {});
});

test('parseBncrMarker: incomplete placeholder does not block later complete marker', () => {
  const result = parseBncrMarker(
    '说明 [BncrParam:...] 结束\n[BncrParam:{"type":"appmsg","msg":"<appmsg/>"}]',
  );
  assert.equal(result.cleanText, '说明 [BncrParam:...] 结束');
  assert.deepEqual(result.params, { type: 'appmsg', msg: '<appmsg/>' });
});

test('parseBncrMarker: multiple complete markers all stripped, later wins on key', () => {
  const result = parseBncrMarker('hi [BncrParam:{"a":1,"b":2}] mid [BncrParam:{"b":9,"c":3}] bye');
  assert.equal(result.cleanText, 'hi mid bye');
  assert.deepEqual(result.params, { a: 1, b: 9, c: 3 });
});

test('parseBncrMarker: incomplete then complete keeps incomplete only', () => {
  const result = parseBncrMarker(
    'broken [BncrParam:{"key":"val"} still [BncrParam:{"ok":true}] done',
  );
  // First incomplete left; second complete stripped
  assert.equal(result.cleanText, 'broken [BncrParam:{"key":"val"} still done');
  assert.deepEqual(result.params, { ok: true });
});
