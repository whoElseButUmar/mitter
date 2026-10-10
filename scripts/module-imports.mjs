/** Build-only syntax inspection. Using an AST avoids treating text in prompts,
 * comments, regexes or generated-code examples as real JavaScript imports. */
const {default:ts}=await import(process.env.MITTER_TYPESCRIPT_MODULE||'typescript');

export function moduleReferences(source,fileName='module.ts') {
  const file=ts.createSourceFile(fileName,source,ts.ScriptTarget.Latest,true);
  const references=[];
  const add=(node,value,typeOnly=false)=>{
    if(typeof value==='string')references.push({specifier:value,typeOnly,line:file.getLineAndCharacterOfPosition(node.getStart(file)).line+1});
  };
  function visit(node) {
    if(ts.isImportDeclaration(node)) {
      const clause=node.importClause;
      const named=clause?.namedBindings;
      const allTypes=!!named&&ts.isNamedImports(named)&&named.elements.length>0&&named.elements.every(e=>e.isTypeOnly)&&!clause.name;
      add(node,node.moduleSpecifier.text,!!clause?.isTypeOnly||allTypes);
    } else if(ts.isExportDeclaration(node)&&node.moduleSpecifier) {
      const named=node.exportClause;
      const allTypes=!!named&&ts.isNamedExports(named)&&named.elements.length>0&&named.elements.every(e=>e.isTypeOnly);
      add(node,node.moduleSpecifier.text,!!node.isTypeOnly||allTypes);
    } else if(ts.isImportEqualsDeclaration(node)&&ts.isExternalModuleReference(node.moduleReference)) {
      add(node,node.moduleReference.expression?.text,!!node.isTypeOnly);
    } else if(ts.isCallExpression(node)&&(
      node.expression.kind===ts.SyntaxKind.ImportKeyword||
      (ts.isIdentifier(node.expression)&&node.expression.text==='require')
    )) {
      const arg=node.arguments[0];
      if(arg&&(ts.isStringLiteral(arg)||ts.isNoSubstitutionTemplateLiteral(arg)))add(node,arg.text);
    }
    ts.forEachChild(node,visit);
  }
  visit(file);
  return references;
}
export function isFrameworkSpecifier(value) {
  return /^(?:solid-js(?:\/|$)|wxt(?:\/|$)|@wxt-dev\/|#imports(?:\/|$))/.test(value);
}
