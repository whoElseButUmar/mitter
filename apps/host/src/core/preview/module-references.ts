import { parseSync, Visitor, type ESTree } from 'rolldown/utils';

/** Parse without executing source. The same installed parser is shipped by the
 * local installer; strings, comments, regexes and templates retain JS semantics. */
export function javascriptReferences(source: string, allowBackend = false): string[] {
  const parsed = parseSync('preview.mjs', source);
  if (parsed.errors.length > 0) {
    const detail = parsed.errors
      .slice(0, 3)
      .map((error) => error.message)
      .join('; ');
    throw new Error('Cannot preview an app script with invalid JavaScript: ' + detail.slice(0, 800));
  }
  const references: string[] = [];
  const literal = (node: ESTree.Expression) => {
    if (node.type === 'Literal' && typeof node.value === 'string') {
      references.push(node.value);
      return;
    }
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
      const value = node.quasis[0]?.value.cooked;
      if (typeof value === 'string') {
        references.push(value);
        return;
      }
    }
    throw new Error('Computed module imports need a frontend build before static preview.');
  };
  new Visitor({
    ImportDeclaration(node) {
      references.push(node.source.value);
    },
    ExportNamedDeclaration(node) {
      if (node.source) {
        references.push(node.source.value);
      }
    },
    ExportAllDeclaration(node) {
      references.push(node.source.value);
    },
    ImportExpression(node) {
      literal(node.source);
    },
    MetaProperty(node) {
      if (node.meta.name === 'import') {
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
    },
    MemberExpression(node) {
      if (!node.computed && node.property.type === 'Identifier' && node.property.name === 'serviceWorker') {
        throw new Error('Service workers are unavailable in temporary static previews.');
      }
    },
  }).visit(parsed.program);
  return references;
}
