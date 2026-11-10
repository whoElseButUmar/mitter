import { parseSync, Visitor } from 'rolldown/utils';

/** Inspect syntax so strings and comments cannot masquerade as module imports. */
export function moduleReferences(source, filename = 'module.ts') {
  const parsed = parseSync(filename, source);

  if (parsed.errors.length > 0) {
    const details = parsed.errors.map((error) => {
      return error.message;
    });

    throw new Error('Cannot inspect ' + filename + ': ' + details.join('; '));
  }

  const references = [];

  function addReference(node, specifier, typeOnly = false) {
    if (typeof specifier !== 'string') {
      return;
    }

    const precedingLines = source.slice(0, node.start).split(/\r\n?|\n/);

    references.push({
      specifier,
      typeOnly,
      line: precedingLines.length,
    });
  }

  function stringValue(node) {
    if (node?.type === 'Literal') {
      return node.value;
    }

    if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
      return node.quasis[0]?.value.cooked;
    }

    return undefined;
  }

  const visitor = new Visitor({
    ImportDeclaration(node) {
      const onlyNamedTypes =
        node.specifiers.length > 0 &&
        node.specifiers.every((specifier) => {
          return specifier.importKind === 'type';
        });

      addReference(node, node.source.value, node.importKind === 'type' || onlyNamedTypes);
    },

    ExportNamedDeclaration(node) {
      if (!node.source) {
        return;
      }

      const onlyNamedTypes =
        node.specifiers.length > 0 &&
        node.specifiers.every((specifier) => {
          return specifier.exportKind === 'type';
        });

      addReference(node, node.source.value, node.exportKind === 'type' || onlyNamedTypes);
    },

    ExportAllDeclaration(node) {
      addReference(node, node.source.value, node.exportKind === 'type');
    },

    TSImportEqualsDeclaration(node) {
      if (node.moduleReference.type === 'TSExternalModuleReference') {
        addReference(node, stringValue(node.moduleReference.expression), node.importKind === 'type');
      }
    },

    ImportExpression(node) {
      addReference(node, stringValue(node.source));
    },

    CallExpression(node) {
      if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
        addReference(node, stringValue(node.arguments[0]));
      }
    },
  });

  visitor.visit(parsed.program);

  return references;
}

export function isFrameworkSpecifier(value) {
  return /^(?:solid-js(?:\/|$)|wxt(?:\/|$)|@wxt-dev\/|#imports(?:\/|$))/.test(value);
}
