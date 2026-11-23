import { ChevronDown, Copy } from 'lucide-solid';
import type { JSX } from 'solid-js';
import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { searchTopics, topicGroups, topics } from './catalog.js';
import type { DocsBlock, DocsSchema } from './content-types.js';
import { schemaText, schemaTitle } from './schema-reference.js';

type DocsPageProps = {
  brandMark: JSX.Element;
  toolbarLinks: { label: string; href: string }[];
};

function CodeSample(props: { text: string; caption: string }) {
  const [status, setStatus] = createSignal('');

  async function copy() {
    try {
      await navigator.clipboard.writeText(props.text);
      setStatus('Copied');
    } catch {
      setStatus('Couldn’t copy. Select the code to copy it.');
    }
  }

  return (
    <figure class="docs-code">
      <figcaption>
        <span>{props.caption}</span>
        <span class="docs-copy-feedback" role="status">
          {status()}
        </span>
        <button type="button" onClick={() => void copy()} aria-label={'Copy ' + props.caption}>
          <Copy size={16} aria-hidden="true" /> Copy
        </button>
      </figcaption>
      <pre tabindex="0" aria-label={props.caption}>
        <code>{props.text}</code>
      </pre>
    </figure>
  );
}

function SchemaSample(props: { schema: DocsSchema }) {
  const [text, setText] = createSignal('');
  const title = schemaTitle(props.schema);

  return (
    <details
      class="docs-schema"
      onToggle={(event) => {
        if (event.currentTarget.open && !text()) {
          setText(schemaText(props.schema));
        }
      }}
    >
      <summary>{title} · JSON Schema</summary>
      <Show when={text()}>{(value) => <CodeSample text={value()} caption={title + ' schema'} />}</Show>
    </details>
  );
}

function ArticleBlock(props: { block: DocsBlock }) {
  const block = props.block;
  switch (block.kind) {
    case 'heading':
      return <h2>{block.text}</h2>;
    case 'text':
      return <p>{block.text}</p>;
    case 'note':
      return (
        <aside class="docs-note">
          <p>{block.text}</p>
        </aside>
      );
    case 'steps':
      return (
        <ol>
          <For each={block.items}>{(item) => <li>{item}</li>}</For>
        </ol>
      );
    case 'list':
      return (
        <ul>
          <For each={block.items}>{(item) => <li>{item}</li>}</For>
        </ul>
      );
    case 'terms':
      return (
        <dl class="docs-terms">
          <For each={block.items}>
            {(item) => (
              <div>
                <dt>{item.name}</dt>
                <dd>{item.description}</dd>
              </div>
            )}
          </For>
        </dl>
      );
    case 'links':
      return (
        <ul class="docs-related">
          <For each={block.items}>
            {(item) => (
              <li>
                <a href={'#' + item.id}>{item.label}</a>
              </li>
            )}
          </For>
        </ul>
      );
    case 'code':
      return <CodeSample caption={block.caption ?? block.language.toUpperCase()} text={block.text} />;
    case 'schema':
      return <SchemaSample schema={block.schema} />;
  }
}

export function DocsPage(props: DocsPageProps) {
  const introduction = topics.find((topic) => topic.id === 'introduction');
  if (!introduction) {
    throw new Error('The Miter Docs introduction is missing.');
  }

  const readTopic = () => topics.find((topic) => '#' + topic.id === location.hash) ?? introduction;
  const [topic, setTopic] = createSignal(readTopic());
  const [draft, setDraft] = createSignal('');
  const [browse, setBrowse] = createSignal(false);
  const query = () => draft().trim();
  const results = createMemo(() => searchTopics(query()));
  const index = () => topics.indexOf(topic());
  let heading: HTMLHeadingElement | undefined;

  function focusArticle() {
    queueMicrotask(() => {
      window.scrollTo(0, 0);
      heading?.focus({ preventScroll: true });
    });
  }

  function navigate() {
    const current = readTopic();
    setTopic(current);
    setDraft('');
    setBrowse(false);
    document.title = current.title + ' | Miter Docs';
    focusArticle();
  }

  onMount(() => {
    document.title = topic().title + ' | Miter Docs';
    window.addEventListener('hashchange', navigate);
    onCleanup(() => window.removeEventListener('hashchange', navigate));
  });

  function openTopic(id: string) {
    if (location.hash === '#' + id) {
      navigate();
      return;
    }
    location.hash = id;
  }

  function useLink(event: MouseEvent, id: string) {
    if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && location.hash === '#' + id) {
      event.preventDefault();
      navigate();
    }
  }

  return (
    <div class="docs-page">
      <a
        class="docs-skip"
        href="#docs-content"
        onClick={(event) => {
          event.preventDefault();
          heading?.focus();
        }}
      >
        Skip to content
      </a>
      <header class="docs-toolbar">
        <a class="docs-brand" href="#introduction" onClick={(event) => useLink(event, 'introduction')}>
          {props.brandMark}
          <span>
            Miter <strong>Docs</strong>
          </span>
        </a>
        <form
          class="docs-search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            const result = results()[0];
            if (result) {
              openTopic(result.id);
            }
          }}
        >
          <label class="docs-visually-hidden" for="docs-search">
            Search documentation
          </label>
          <input
            id="docs-search"
            type="search"
            placeholder="Search docs"
            value={draft()}
            onInput={(event) => setDraft(event.currentTarget.value)}
          />
        </form>
        <nav class="docs-toolbar-links" aria-label="Miter links">
          <For each={props.toolbarLinks}>{(link) => <a href={link.href}>{link.label}</a>}</For>
        </nav>
      </header>
      <div class="docs-layout">
        <aside class="docs-sidebar">
          <button
            class="docs-browse"
            type="button"
            aria-expanded={browse()}
            aria-controls="docs-topics"
            onClick={() => setBrowse(!browse())}
          >
            Browse topics <ChevronDown size={16} aria-hidden="true" />
          </button>
          <nav id="docs-topics" classList={{ 'docs-nav-open': browse() }} aria-label="Documentation topics">
            <For each={topicGroups}>
              {(group) => (
                <section class="docs-nav-group">
                  <h2>{group.label}</h2>
                  <ul>
                    <For each={group.topics}>
                      {(entry) => (
                        <li>
                          <a
                            href={'#' + entry.id}
                            aria-current={(topic().id === entry.id && !query() && 'page') || undefined}
                            onClick={(event) => useLink(event, entry.id)}
                          >
                            {entry.title}
                          </a>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              )}
            </For>
          </nav>
        </aside>
        <main id="docs-content" class="docs-main">
          <Show
            when={query()}
            fallback={
              <Show keyed when={topic()}>
                {(entry) => (
                  <article class="docs-article">
                    <h1
                      tabindex="-1"
                      ref={(element) => {
                        heading = element;
                      }}
                    >
                      {entry.title}
                    </h1>
                    <p class="docs-summary">{entry.summary}</p>
                    <For each={entry.blocks}>{(block) => <ArticleBlock block={block} />}</For>
                    <nav class="docs-pager" aria-label="Read adjacent topics">
                      <Show when={topics[index() - 1]}>
                        {(previous) => (
                          <a href={'#' + previous().id}>
                            <span>Previous</span>
                            {previous().title}
                          </a>
                        )}
                      </Show>
                      <Show when={topics[index() + 1]}>
                        {(next) => (
                          <a href={'#' + next().id}>
                            <span>Next</span>
                            {next().title}
                          </a>
                        )}
                      </Show>
                    </nav>
                  </article>
                )}
              </Show>
            }
          >
            <section class="docs-article">
              <h1
                tabindex="-1"
                ref={(element) => {
                  heading = element;
                }}
              >
                Search results
              </h1>
              <p class="docs-summary" role="status">
                {results().length} topics for “{query()}”
              </p>
              <Show when={results().length} fallback={<p>Try “install”, “terminal”, or “replyTo”.</p>}>
                <ul class="docs-result-list">
                  <For each={results()}>
                    {(entry) => (
                      <li>
                        <a href={'#' + entry.id} onClick={(event) => useLink(event, entry.id)}>
                          <strong>{entry.title}</strong>
                          <span>{entry.summary}</span>
                        </a>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </section>
          </Show>
        </main>
      </div>
    </div>
  );
}
