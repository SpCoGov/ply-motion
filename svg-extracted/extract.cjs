// Extract data only; never evaluate the source JavaScript.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const source = 'C:/Users/Administrator/Desktop/新建 文本文档.txt';
const text = fs.readFileSync(source, 'utf8');
const out = __dirname;
for (const dir of ['svg', 'templates', 'original-fragments']) fs.mkdirSync(path.join(out, dir), {recursive: true});
const entries = [];
const complete = [...text.matchAll(/<svg\b[\s\S]*?<\/svg\s*>/g)];
const fragments = [...text.matchAll(/`\s*(?=<(?:g|path|circle|rect|polygon|ellipse|line|polyline|defs|symbol)\b)((?:\\[\s\S]|[^`\\])*)`/g)];
const constants = {
  'W.ClassNames.Shadow': 'icon-shadow', 'W.ClassNames.Background': 'icon-background',
  'W.ClassNames.ComponentShadow': 'icon-component-shadow', 'W.ClassNames.Component': 'icon-component',
  'zs.SHADOW': 'icon-shadow', 'zs.BACKGROUND': 'icon-background',
  'zs.COMPONENT_SHADOW': 'icon-component-shadow', 'zs.COMPONENT': 'icon-component',
};
const assets = [
  ...complete.map(m => ({start:m.index, end:m.index+m[0].length, raw:m[0], kind:m[0].includes('${')?'template':'complete'})),
  ...fragments.map(m => ({start:m.index, end:m.index+m[0].length, raw:m[1].trim(), kind:'fragment'})),
].sort((a,b)=>a.start-b.start);
for (const [i, asset] of assets.entries()) {
  const variable = text.slice(Math.max(0,asset.start-60),asset.start).match(/([\w$]+)=$/)?.[1];
  const id = asset.raw.match(/^<g\s+id="([^"]+)"/)?.[1];
  const label = id || variable || (asset.start===0?'star':asset.kind==='template'?'dynamic-svg':'icon');
  const basename = `${String(i+1).padStart(3,'0')}-${label.replace(/[^\w-]/g,'_')}`;
  let svg = asset.raw;
  let file;
  if(asset.kind==='template') {
    file=`templates/${basename}.svg.txt`;
  } else {
    file=`svg/${basename}.svg`;
    if(asset.kind==='fragment') {
      fs.writeFileSync(path.join(out,`original-fragments/${basename}.txt`),asset.raw);
      svg=svg.replace(/\$\{([^}]+)\}/g,(_,key)=>{assert.ok(Object.hasOwn(constants,key),key);return constants[key];});
      svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 19" width="72" height="76">\n${svg}\n</svg>`;
    }
    assert.ok(!svg.includes('${'),file);
  }
  fs.writeFileSync(path.join(out,file),svg);
  entries.push({file,kind:asset.kind,sourceVariable:variable||null,id:id||null,line:text.slice(0,asset.start).split('\n').length,characterOffset:asset.start,bytes:Buffer.byteLength(svg)});
}
// Keep coordinate label templates, which are not standalone pictures.
const labels=[...text.matchAll(/<text\s[\s\S]*?<\/text>/g)].filter(m=>!assets.some(a=>m.index>=a.start&&m.index<a.end));
for(const [i,m] of labels.entries()) fs.writeFileSync(path.join(out,`templates/coordinate-label-${i+1}.txt`),m[0]);
const refs=[...new Set([...text.matchAll(/[`"']([^`"'\r\n]*\.svg)[`"']/g)].map(m=>m[1]))];
fs.writeFileSync(path.join(out,'external-svg-references.txt'),refs.join('\n')+'\n');
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify({source,sourceBytes:fs.statSync(source).size,entries,coordinateTemplates:labels.length,externalReferences:refs},null,2));
const escape=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cards=entries.filter(e=>e.kind!=='template').map(e=>`<a href="${e.file}"><img loading="lazy" src="${e.file}" alt="${escape(e.id||e.sourceVariable||e.file)}"><span>${escape(path.basename(e.file))}</span></a>`).join('\n');
fs.writeFileSync(path.join(out,'index.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>SVG 提取预览</title><style>body{font:16px system-ui;margin:32px;background:#f4f4f4;color:#222}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:14px}a{background:#41454b;padding:18px;color:white;text-decoration:none;border-radius:10px;display:flex;align-items:center;flex-direction:column;gap:12px}img{width:80px;height:84px}span{font-size:12px;overflow-wrap:anywhere}p{line-height:1.7}</style><h1>SVG 提取预览</h1><p>3 个完整静态 SVG · 60 个补齐外层的图标片段。点击图标打开文件。<br>2 个动态 SVG 模板及 2 个坐标文字模板保存在 templates。白色图形使用深色背景展示。</p><main>${cards}</main></html>`);
fs.writeFileSync(path.join(out,'README.txt'),`分析与提取说明\n\n源文件：${source}\n文件大小：${fs.statSync(source).size} 字节。内容是截取的 JavaScript 打包代码，包含国际象棋界面图标，不是一个完整 SVG 文件。文件以 SVG 内容开始、以 JavaScript 逗号结束。\n\n提取结果：\n- svg/：63 个可独立打开的 SVG。其中 3 个原始完整静态 SVG，60 个由图标片段封装而成。\n- templates/：2 个完整动态 SVG 模板，2 个动态坐标文字模板。保留原文，未猜测运行时内容。\n- original-fragments/：60 个片段的原始文本，包含原来的变量占位符。\n- index.html：本地图库预览，点击可打开 SVG。\n- manifest.json：文件名、原变量名、源行号和字符位置。字符位置从 0 开始，按 JavaScript UTF-16 计数。\n- external-svg-references.txt：${refs.length} 个去重后的 SVG 路径或路径模板；源文件没有包含它们的图像内容，因此无法从本文件还原。\n\n处理方式：完整静态 SVG 原样保留；图标片段只补齐 SVG 外层，并根据原代码将 W.ClassNames / zs 常量替换为实际 class 名称。viewBox 使用源代码 Aa() 默认值 0 0 18 19，导出尺寸为 72 × 76，可无损缩放。未执行源文件 JavaScript。外部 CSS 可能影响原站展示，导出保留片段自带颜色与样式。\n\n可重新运行：node extract.cjs\n`);
assert.equal(complete.length,5);
assert.equal(fragments.length,60);
assert.equal(entries.filter(e=>e.kind!=='template').length,63);
assert.equal(labels.length,2);
console.log(JSON.stringify({svg:63,svgTemplates:2,coordinateTemplates:labels.length,externalReferences:refs,output:out},null,2));
