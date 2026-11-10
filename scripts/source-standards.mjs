import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSync, Visitor } from 'rolldown/utils';

const generatedDirectories = new Set([
  'node_modules',
  'dist',
  '.output',
  '.wxt',
  '.git',
  '.cache',
  '.pnpm-store',
]);
const generatedScripts = new Set([
  path.join('apps', 'extension', 'public', 'mitter-page.js'),
  path.join('apps', 'extension', 'public', 'preview-sandbox.js'),
]);

export async function sourceFiles(root, directories = ['apps', 'packages', 'scripts']) {
  const files = [];

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (generatedDirectories.has(entry.name)) {
        continue;
      }

      const filename = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await visit(filename);
        continue;
      }

      if (!entry.isFile() || !/\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name)) {
        continue;
      }

      if (generatedScripts.has(path.relative(root, filename))) {
        continue;
      }

      files.push(filename);
    }
  }

  for (const directory of directories) {
    await visit(path.join(root, directory));
  }

  return files.sort();
}

function sourceLine(source, offset) {
  return source.slice(0, offset).split(/\r\n?|\n/).length;
}

const schemaConstructors = new Set([
  'any',
  'array',
  'bigint',
  'boolean',
  'custom',
  'date',
  'discriminatedUnion',
  'enum',
  'file',
  'function',
  'instanceof',
  'int',
  'intersection',
  'lazy',
  'literal',
  'looseObject',
  'map',
  'nan',
  'never',
  'null',
  'number',
  'object',
  'preprocess',
  'promise',
  'record',
  'set',
  'strictObject',
  'string',
  'symbol',
  'templateLiteral',
  'tuple',
  'undefined',
  'union',
  'unknown',
  'void',
]);

function memberName(node) {
  if (node.type !== 'MemberExpression') {
    return undefined;
  }

  if (!node.computed && node.property.type === 'Identifier') {
    return node.property.name;
  }

  if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string') {
    return node.property.value;
  }

  return undefined;
}

function schemaDeclarations(program) {
  const namespaces = new Set(['z']);
  const imports = new Map();
  const exportedNames = new Set();

  for (const statement of program.body) {
    if (statement.type === 'ImportDeclaration' && /^zod(?:\/|$)/.test(statement.source.value)) {
      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ImportNamespaceSpecifier') {
          namespaces.add(specifier.local.name);
        } else if (specifier.type === 'ImportSpecifier') {
          if (specifier.imported.name === 'z') {
            namespaces.add(specifier.local.name);
          } else {
            imports.set(specifier.local.name, specifier.imported.name);
          }
        }
      }
    }

    if (statement.type !== 'ExportNamedDeclaration' || statement.source || statement.exportKind === 'type') {
      continue;
    }

    if (statement.declaration?.type === 'VariableDeclaration') {
      for (const declaration of statement.declaration.declarations) {
        if (declaration.id.type === 'Identifier') {
          exportedNames.add(declaration.id.name);
        }
      }
    }

    for (const specifier of statement.specifiers) {
      if (specifier.exportKind !== 'type') {
        exportedNames.add(specifier.local.name);
      }
    }
  }

  function zodMethod(callee) {
    if (callee.type === 'Identifier') {
      return imports.get(callee.name);
    }

    if (callee.type !== 'MemberExpression') {
      return undefined;
    }

    let receiver = callee.object;

    if (memberName(receiver) === 'coerce') {
      receiver = receiver.object;
    }

    if (receiver.type === 'Identifier' && namespaces.has(receiver.name)) {
      return memberName(callee);
    }

    return undefined;
  }

  return { exportedNames, zodMethod };
}

function constructsSchema(node, zodMethod) {
  while (node?.type === 'TSSatisfiesExpression') {
    node = node.expression;
  }

  while (node?.type === 'CallExpression') {
    const method = zodMethod(node.callee);

    if (method) {
      return schemaConstructors.has(method);
    }

    if (['parse', 'parseAsync', 'safeParse', 'safeParseAsync'].includes(memberName(node.callee))) {
      return false;
    }

    node = node.callee.object;
  }

  return false;
}

function hasDescription(node, zodMethod) {
  while (node?.type === 'TSSatisfiesExpression') {
    node = node.expression;
  }

  if (node?.type !== 'CallExpression') {
    return false;
  }

  function hasText(description) {
    if (!description || description.type === 'SpreadElement') {
      return false;
    }

    if (description.type === 'Literal') {
      return typeof description.value === 'string' && description.value.trim().length > 0;
    }

    if (description.type === 'TemplateLiteral' && description.expressions.length === 0) {
      return description.quasis.some((part) => (part.value.cooked ?? part.value.raw).trim().length > 0);
    }

    // Named descriptions are checked at runtime by schema contract tests.
    return true;
  }

  if (memberName(node.callee) === 'describe') {
    return hasText(node.arguments[0]);
  }

  if (memberName(node.callee) === 'check') {
    return node.arguments.some((argument) => {
      return (
        argument.type === 'CallExpression' &&
        zodMethod(argument.callee) === 'describe' &&
        hasText(argument.arguments[0])
      );
    });
  }

  return false;
}

export function sourceViolations(source, filename = 'source.ts') {
  const parsed = parseSync(filename, source);
  const violations = [];

  for (const error of parsed.errors) {
    const offset = error.labels[0]?.start ?? 0;
    violations.push({
      file: filename,
      line: sourceLine(source, offset),
      rule: 'syntax',
      message: error.message,
    });
  }

  if (parsed.errors.length > 0) {
    return violations;
  }

  const { exportedNames, zodMethod } = schemaDeclarations(parsed.program);

  function report(node, rule, message) {
    const line = sourceLine(source, node.start);
    violations.push({ file: filename, line, rule, message });
  }

  function checkLoop(node) {
    if (node.body.type !== 'BlockStatement') {
      report(node, 'braces', 'Use braces around the loop body.');
    }
  }

  function checkDefiniteAssignment(node) {
    if (node.definite) {
      report(
        node,
        'assignment',
        'Initialize the value or check it before use instead of asserting assignment.',
      );
    }
  }

  new Visitor({
    TSAnyKeyword(node) {
      report(node, 'any', 'Use a proved type or unknown with checked narrowing.');
    },
    TSInterfaceDeclaration(node) {
      report(node, 'interface', 'Use a type alias, inferred from a schema for serialized data.');
    },
    TSNonNullExpression(node) {
      report(node, 'assertion', 'Check that the value exists before using it.');
    },
    TSTypeAssertion(node) {
      report(node, 'assertion', 'Validate or narrow the value instead of casting it.');
    },
    TSAsExpression(node) {
      const annotation = node.typeAnnotation;
      const constantLiteral = annotation.type === 'TSTypeReference' && annotation.typeName.name === 'const';

      if (!constantLiteral) {
        report(node, 'assertion', 'Validate or narrow the value instead of casting it.');
      }
    },
    ConditionalExpression(node) {
      report(node, 'conditional', 'Use an explicit branch or a named helper instead of a ternary.');
    },
    CallExpression(node) {
      const method = zodMethod(node.callee);

      if (method === 'any') {
        report(node, 'schema-any', 'Use a validating schema or z.unknown() with checked narrowing.');
      }

      if (method === 'custom' && node.arguments.length === 0) {
        report(node, 'schema', 'Provide a validating predicate instead of asserting a custom schema type.');
      }

      if (
        node.typeArguments &&
        node.callee.type === 'MemberExpression' &&
        node.callee.property.type === 'Identifier' &&
        ['querySelector', 'querySelectorAll', 'closest'].includes(node.callee.property.name)
      ) {
        report(
          node,
          'assertion',
          'Check the DOM node constructor instead of asserting a selector result type.',
        );
      }
    },
    PropertyDefinition: checkDefiniteAssignment,
    VariableDeclarator(node) {
      checkDefiniteAssignment(node);

      if (
        node.id.type === 'Identifier' &&
        exportedNames.has(node.id.name) &&
        constructsSchema(node.init, zodMethod) &&
        !hasDescription(node.init, zodMethod)
      ) {
        report(node, 'schema-description', 'Describe the exported schema itself in plain English.');
      }
    },
    IfStatement(node) {
      if (node.consequent.type !== 'BlockStatement') {
        report(node, 'braces', 'Use braces around the if branch.');
      }

      if (
        node.alternate &&
        node.alternate.type !== 'BlockStatement' &&
        node.alternate.type !== 'IfStatement'
      ) {
        report(node, 'braces', 'Use braces around the else branch.');
      }
    },
    ForStatement: checkLoop,
    ForOfStatement: checkLoop,
    ForInStatement: checkLoop,
    WhileStatement: checkLoop,
    DoWhileStatement: checkLoop,
  }).visit(parsed.program);

  return violations;
}

export async function checkSourceStandards(root, directories) {
  const files = await sourceFiles(root, directories);
  const violations = [];

  for (const filename of files) {
    const source = await readFile(filename, 'utf8');
    violations.push(...sourceViolations(source, path.relative(root, filename)));
  }

  return { checked: files.length, violations };
}
