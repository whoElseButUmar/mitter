import { parseSync, Visitor, type ESTree } from 'rolldown/utils';

function staticString(node: ESTree.Expression): string | undefined {
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

function localImage(value: string): boolean {
  const pathname = value.split(/[?#]/, 1)[0] ?? '';
  return (
    !/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(pathname) &&
    !/[\s\\<>"'`]/.test(pathname) &&
    /\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/i.test(pathname)
  );
}

/** Parse without executing source. The same installed parser is shipped by the
 * local installer; strings, comments, regexes and templates retain JS semantics. */
export function javascriptReferences(source: string, allowBackend = false) {
  const parsed = parseSync('preview.mjs', source);
  if (parsed.errors.length > 0) {
    const detail = parsed.errors
      .slice(0, 3)
      .map((error) => error.message)
      .join('; ');
    throw new Error('Cannot preview an app script with invalid JavaScript: ' + detail.slice(0, 800));
  }
  const modules: string[] = [];
  const moduleImages = new Set<string>();
  const documentImages = new Set<string>();
  const moduleImageArguments = new WeakSet<ESTree.Expression>();
  const imageBases = new WeakSet<ESTree.MetaProperty>();
  const collectImage = (node: ESTree.Expression) => {
    const value = staticString(node);
    if (value !== undefined && !moduleImageArguments.has(node) && localImage(value)) {
      documentImages.add(value);
    }
  };
  new Visitor({
    Literal: collectImage,
    TemplateLiteral: collectImage,
    ImportDeclaration(node) {
      modules.push(node.source.value);
    },
    ExportNamedDeclaration(node) {
      if (node.source) {
        modules.push(node.source.value);
      }
    },
    ExportAllDeclaration(node) {
      modules.push(node.source.value);
    },
    ImportExpression(node) {
      const value = staticString(node.source);
      if (value === undefined) {
        throw new Error('Computed module imports need a frontend build before static preview.');
      }
      modules.push(value);
    },
    MetaProperty(node) {
      if (node.meta.name === 'import' && !imageBases.has(node)) {
        throw new Error('import.meta resource resolution needs a frontend build before static preview.');
      }
    },
    CallExpression(node) {
      if (
        node.callee.type === 'Identifier' &&
        (node.callee.name === 'require' || (!allowBackend && node.callee.name === 'fetch'))
      ) {
        throw new Error(
          'Backend, package and network requests need an app server or frontend build; this preview serves static assets only.',
        );
      }
    },
    NewExpression(node) {
      if (node.callee.type === 'Identifier' && ['WebSocket', 'EventSource'].includes(node.callee.name)) {
        throw new Error('Network connections need an app server; this preview serves static assets only.');
      }
      const [image, base] = node.arguments;
      if (
        node.callee.type === 'Identifier' &&
        node.callee.name === 'URL' &&
        node.arguments.length === 2 &&
        image &&
        image.type !== 'SpreadElement' &&
        base?.type === 'MemberExpression' &&
        !base.computed &&
        base.property.type === 'Identifier' &&
        base.property.name === 'url' &&
        base.object.type === 'MetaProperty' &&
        base.object.meta.name === 'import'
      ) {
        const value = staticString(image);
        if (value !== undefined && localImage(value)) {
          moduleImages.add(value);
          moduleImageArguments.add(image);
          imageBases.add(base.object);
        }
      }
    },
    MemberExpression(node) {
      if (!node.computed && node.property.type === 'Identifier' && node.property.name === 'serviceWorker') {
        throw new Error('Service workers are unavailable in temporary static previews.');
      }
    },
  }).visit(parsed.program);
  return { modules, moduleImages, documentImages };
}
