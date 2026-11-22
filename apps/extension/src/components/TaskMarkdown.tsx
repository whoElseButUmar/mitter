import MarkdownIt from 'markdown-it';
import { createMemo } from 'solid-js';

const markdown = new MarkdownIt({ html: false, breaks: true });

markdown.validateLink = (url) => /^https?:\/\//i.test(url);
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index]?.content || '');
markdown.renderer.rules.link_open = (tokens, index, options, _environment, renderer) => {
  const token = tokens[index];
  if (token) {
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer');
  }
  return renderer.renderToken(tokens, index, options);
};

export function TaskMarkdown(props: { source: string }) {
  // The parser escapes raw HTML. Links are HTTP(S) only and images stay text.
  const content = createMemo(() => markdown.render(props.source));
  return <div class="task-markdown" innerHTML={content()} />;
}
