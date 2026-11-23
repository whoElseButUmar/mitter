import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../../packages/bridge/src/runner/test-source-loader.mjs';

const { searchTopics, topics } = await import('../../packages/docs/src/catalog.ts');
const { schemaText } = await import('../../packages/docs/src/schema-reference.ts');
const { proposalEnvelopeSchema } = await import('../../packages/protocol/src/schemas/envelopes.ts');

test('documentation topics have unique addresses and working cross-links', () => {
  const ids = new Set(topics.map((topic) => topic.id));
  assert.equal(ids.size, topics.length);
  assert.ok(ids.has('introduction'));
  assert.ok(ids.has('getting-started'));

  for (const topic of topics) {
    assert.match(topic.id, /^[a-z]+(?:-[a-z]+)*$/);
    for (const block of topic.blocks) {
      if (block.kind === 'links') {
        for (const link of block.items) {
          assert.ok(ids.has(link.id), topic.id + ' links to ' + link.id);
        }
      }
    }
  }
});

test('topic search includes exact protocol terminology and familiar phrases', () => {
  assert.ok(searchTopics('replyTo').some((topic) => topic.id === 'reply-shape'));
  assert.ok(searchTopics('paste screenshot').some((topic) => topic.id === 'attachments-and-rewrite'));
  assert.deepEqual(searchTopics('unmatchedtopicname'), []);
});

test('schema references export from the current validators and include the correlated reply example', () => {
  const schemaBlocks = topics.flatMap((topic) => topic.blocks).filter((block) => block.kind === 'schema');
  assert.equal(new Set(schemaBlocks.map((block) => block.schema)).size, 17);
  for (const block of schemaBlocks) {
    const schema = JSON.parse(schemaText(block.schema));
    assert.match(schema.$schema, /^https:\/\/json-schema.org\//);
  }
  const reply = JSON.parse(schemaText('reply'));
  assert.ok(reply.required.includes('replyTo'));
  assert.equal(reply.properties.protocol.const, 'mitter/1');

  const example = topics
    .find((topic) => topic.id === 'reply-shape')
    ?.blocks.find((block) => block.kind === 'code' && block.language === 'json');
  assert.ok(example);
  const parsed = proposalEnvelopeSchema.parse(JSON.parse(example.text));
  assert.ok(parsed.replyTo);
});
