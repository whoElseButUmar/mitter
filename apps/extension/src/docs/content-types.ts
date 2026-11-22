export type DocsSchema =
  | 'reply'
  | 'proposal'
  | 'action'
  | 'envelope'
  | 'check'
  | 'worker'
  | 'followup'
  | 'image'
  | 'commandProfile'
  | 'preview'
  | 'request'
  | 'response'
  | 'workerCreate'
  | 'rewriteRequest'
  | 'rewriteReply'
  | 'pageRequest'
  | 'pageReply';

export type DocsBlock =
  | { kind: 'heading' | 'text' | 'note'; text: string }
  | { kind: 'steps' | 'list'; items: string[] }
  | { kind: 'code'; language: 'json' | 'sh' | 'text'; text: string; caption?: string }
  | { kind: 'terms'; items: { name: string; description: string }[] }
  | { kind: 'links'; items: { id: string; label: string }[] }
  | { kind: 'schema'; schema: DocsSchema };

export type DocsTopic = {
  id: string;
  title: string;
  summary: string;
  blocks: DocsBlock[];
};
