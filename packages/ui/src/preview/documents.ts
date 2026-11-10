import { assetDataURL, assetText, localDependency } from './assets.js';
import { PREVIEW_LIMIT, type PreviewAsset, type PreviewDocument } from './schemas.js';

function escaped(source: string): string {
  return source.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': {
        return '&amp;';
      }
      case '<': {
        return '&lt;';
      }
      case '>': {
        return '&gt;';
      }
      case '"': {
        return '&quot;';
      }
      case "'": {
        return '&#39;';
      }
      default: {
        return character;
      }
    }
  });
}

export function markdownDocument(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let code = false;
  let html = '';
  let list = false;
  const inline = (text: string) =>
    escaped(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (list) {
        html += '</ul>';
        list = false;
      }

      if (code) {
        html += '</code></pre>';
      } else {
        html += '<pre><code>';
      }

      code = !code;
      continue;
    }

    if (code) {
      html += escaped(line) + '\n';
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);

    if (heading && heading[1] !== undefined && heading[2] !== undefined) {
      if (list) {
        html += '</ul>';
        list = false;
      }

      const level = heading[1].length;
      html += `<h${level}>${inline(heading[2])}</h${level}>`;
      continue;
    }

    const item = /^\s*[-*+]\s+(.*)$/.exec(line);

    if (item && item[1] !== undefined) {
      if (!list) {
        html += '<ul>';
        list = true;
      }

      html += '<li>' + inline(item[1]) + '</li>';
      continue;
    }

    if (list) {
      html += '</ul>';
      list = false;
    }

    if (line.trim()) {
      html += '<p>' + inline(line) + '</p>';
    }
  }

  if (code) {
    html += '</code></pre>';
  }

  if (list) {
    html += '</ul>';
  }

  return (
    '<!doctype html><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>html{color-scheme:light dark}' +
    'body{font:15px/1.65 system-ui,sans-serif;margin:24px;overflow-wrap:anywhere}' +
    'h1,h2,h3{line-height:1.3}pre{overflow:auto;padding:14px;border:1px solid #8886;border-radius:5px}' +
    'code{font-family:ui-monospace,monospace}p{margin:.65em 0}</style>' +
    html
  );
}

export async function htmlDocument(
  asset: PreviewAsset,
  read: (path: string) => Promise<PreviewAsset>,
): Promise<PreviewDocument> {
  const document = new DOMParser().parseFromString(assetText(asset), 'text/html');
  let used = asset.size;
  let count = 0;
  const warnings: string[] = [];
  const cache = new Map<string, Promise<PreviewAsset>>();

  function dependency(path: string): Promise<PreviewAsset> {
    let found = cache.get(path);

    if (!found) {
      found = (async () => {
        count += 1;

        if (count > 40) {
          throw new Error('Preview contains more than 40 local resources.');
        }

        const file = await read(path);
        used += file.size;

        if (used > PREVIEW_LIMIT) {
          throw new Error('Preview resources exceed 24 MB.');
        }

        return file;
      })();
      cache.set(path, found);
    }

    return found;
  }

  async function css(source: string, path: string): Promise<string> {
    // CSS imports are not fetched implicitly; every local resource is checked by the host.
    if (/@import\b/i.test(source)) {
      warnings.push('CSS @import is disabled in the isolated preview.');
    }

    source = source.replace(/@import\s+(?:url\([^)]*\)|["'][^"']*["'])[^;]*;/gi, '');
    const matches = [...source.matchAll(/url\(\s*["']?([^)'"\s]+)["']?\s*\)/gi)];

    for (const match of matches) {
      const reference = match[1];

      if (reference === undefined) {
        continue;
      }

      const localPath = localDependency(path, reference);

      if (!localPath) {
        continue;
      }

      try {
        const resource = await dependency(localPath);
        source = source.replace(match[0], `url("${assetDataURL(resource)}")`);
      } catch {
        source = source.replace(match[0], 'url("")');
        warnings.push('Could not preview ' + localPath);
      }
    }

    return source;
  }

  for (const element of document.querySelectorAll('base,meta[http-equiv],iframe,object,embed')) {
    element.remove();
  }

  for (const link of Array.from(document.querySelectorAll('link'))) {
    const path = localDependency(asset.path, link.getAttribute('href') || '');

    if (link.getAttribute('rel') === 'stylesheet' && path) {
      try {
        const resource = await dependency(path);
        const style = document.createElement('style');
        style.textContent = await css(assetText(resource), path);
        link.replaceWith(style);
      } catch {
        warnings.push('Could not load stylesheet ' + path);
        link.remove();
      }
    } else {
      link.remove();
    }
  }

  for (const script of Array.from(document.querySelectorAll('script[src]'))) {
    const path = localDependency(asset.path, script.getAttribute('src') || '');

    if (!path) {
      warnings.push('External scripts are disabled.');
      script.remove();
      continue;
    }

    try {
      const resource = await dependency(path);
      script.removeAttribute('src');
      script.removeAttribute('integrity');
      script.textContent = assetText(resource).replace(/<\/script/gi, '<\\/script');
    } catch {
      warnings.push('Could not load script ' + path);
      script.remove();
    }
  }

  for (const media of Array.from(document.querySelectorAll('img,source,video,audio'))) {
    media.removeAttribute('srcset');

    for (const key of ['src', 'poster']) {
      const path = localDependency(asset.path, media.getAttribute(key) || '');

      if (!path) {
        continue;
      }

      try {
        media.setAttribute(key, assetDataURL(await dependency(path)));
      } catch {
        media.removeAttribute(key);
        warnings.push('Could not load ' + path);
      }
    }
  }

  for (const style of Array.from(document.querySelectorAll('style'))) {
    style.textContent = await css(style.textContent || '', asset.path);
  }

  // Modules using imports/fetch and apps needing a server remain desktop-run workflows.
  if (document.querySelector('script[type="module"]')) {
    warnings.push(
      'Module imports and network requests are disabled; use a local dev server for bundled apps.',
    );
  }

  document.documentElement.setAttribute('data-miter-preview', 'isolated');
  return { html: '<!doctype html>' + document.documentElement.outerHTML, warnings: [...new Set(warnings)] };
}
