import type { DocsBlock, DocsTopic } from './content-types.js';
import { architectureTopic } from './architecture.js';
import { guideTopics } from './guides.js';
import { protocolTopics } from './protocol.js';
import { schemaTitle } from './schema-reference.js';

export const topicGroups = [
  { label: 'Start here', topics: guideTopics.slice(0, 3) },
  { label: 'Daily work', topics: guideTopics.slice(3, 10) },
  { label: 'Settings and support', topics: guideTopics.slice(10) },
  { label: 'Technical reference', topics: [architectureTopic, ...protocolTopics] },
];

export const topics = topicGroups.flatMap((group) => group.topics);

function blockText(block: DocsBlock): string {
  switch (block.kind) {
    case 'steps':
    case 'list':
      return block.items.join(' ');
    case 'terms':
      return block.items.map((term) => term.name + ' ' + term.description).join(' ');
    case 'links':
      return block.items.map((item) => item.label).join(' ');
    case 'schema':
      return schemaTitle(block.schema);
    default:
      return block.text;
  }
}

const index = topics.map((topic) => ({
  topic,
  title: topic.title.toLowerCase(),
  body: [topic.title, topic.summary, ...topic.blocks.map(blockText)].join(' ').toLowerCase(),
}));

export function searchTopics(query: string): DocsTopic[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu);
  if (!words) {
    return [];
  }

  return index
    .filter((entry) => words.every((word) => entry.body.includes(word)))
    .map((entry) => ({
      topic: entry.topic,
      rank: words.filter((word) => entry.title.includes(word)).length,
    }))
    .sort((left, right) => right.rank - left.rank)
    .map((entry) => entry.topic);
}
