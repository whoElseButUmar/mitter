/** Bounded line diff for display only. Never used to apply or reconstruct code. */
export interface DiffLine { kind:'same'|'add'|'remove'|'omitted'; text:string; oldLine?:number; newLine?:number }
export interface LineDiff { lines:DiffLine[]; additions:number; deletions:number; truncated:boolean; simplified:boolean }
export function lineDiff(before:string,after:string):LineDiff {
  if(before===after)return {lines:[],additions:0,deletions:0,truncated:false,simplified:false};
  const split=(text:string)=>text===''?[]:text.replace(/\n$/, '').split('\n');
  const a=split(before),b=split(after);
  let prefix=0,suffix=0;
  while(prefix<a.length&&prefix<b.length&&a[prefix]===b[prefix])prefix++;
  while(suffix<a.length-prefix&&suffix<b.length-prefix&&a[a.length-1-suffix]===b[b.length-1-suffix])suffix++;
  const left=a.slice(prefix,a.length-suffix),right=b.slice(prefix,b.length-suffix);
  const lines:DiffLine[]=[];let additions=0,deletions=0,chars=0,truncated=false;
  const add=(line:DiffLine)=>{if(lines.length>=800||chars>=80000){truncated=true;return;}const display=line.text.endsWith('\n')?line.text.slice(0,-1):line.text;const text=display.slice(0,Math.max(0,Math.min(4000,80000-chars)));if(text.length!==display.length)truncated=true;chars+=text.length;lines.push({...line,text});};
  if(prefix>3)add({kind:'omitted',text:`${prefix-3} unchanged lines`});
  for(let i=Math.max(0,prefix-3);i<prefix;i++)add({kind:'same',text:a[i]!,oldLine:i+1,newLine:i+1});
  const simplified=left.length*right.length>250000;
  if(simplified){
    for(let i=0;i<left.length;i++){deletions++;add({kind:'remove',text:left[i]!,oldLine:prefix+i+1});}
    for(let j=0;j<right.length;j++){additions++;add({kind:'add',text:right[j]!,newLine:prefix+j+1});}
  }else{
    const width=right.length+1,table=new Uint32Array((left.length+1)*width);
    for(let i=left.length-1;i>=0;i--)for(let j=right.length-1;j>=0;j--)table[i*width+j]=left[i]===right[j]?table[(i+1)*width+j+1]!+1:Math.max(table[(i+1)*width+j]!,table[i*width+j+1]!);
    let i=0,j=0;
    while(i<left.length||j<right.length){
      if(i<left.length&&j<right.length&&left[i]===right[j]){add({kind:'same',text:left[i]!,oldLine:prefix+i+1,newLine:prefix+j+1});i++;j++;}
      else if(j<right.length&&(i===left.length||table[i*width+j+1]!>table[(i+1)*width+j]!)){additions++;add({kind:'add',text:right[j]!,newLine:prefix+j+1});j++;}
      else{deletions++;add({kind:'remove',text:left[i]!,oldLine:prefix+i+1});i++;}
    }
  }
  for(let s=0;s<Math.min(3,suffix);s++)add({kind:'same',text:a[a.length-suffix+s]!,oldLine:a.length-suffix+s+1,newLine:b.length-suffix+s+1});
  if(suffix>3)add({kind:'omitted',text:`${suffix-3} unchanged lines`});
  if(before.endsWith('\n')!==after.endsWith('\n'))add({kind:'omitted',text:after.endsWith('\n')?'Final newline added':'No final newline in the new version'});
  return {lines,additions,deletions,truncated,simplified};
}
