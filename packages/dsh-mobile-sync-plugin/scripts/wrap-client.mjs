// scripts/wrap-client.mjs
// 将 tsdown 输出的 ESM client.js 包装成 DSH ModuleLoader 格式
// DSH client bundle 必须是 window.__ModuleLoader__.load({ id, factory }) 格式
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientPath = join(__dirname, '..', 'lib', 'client.js');

async function main() {
  const code = await readFile(clientPath, 'utf-8');

  // 1. 提取 import 语句并生成 require 声明
  const requireDecls = [];
  let body = code;

  // 处理: import { a, b as c } from "module"
  // 处理: import defaultName from "module"
  // 处理: import defaultName, { a, b } from "module"
  const lines = body.split('\n');
  const filteredLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const importMatch = trimmed.match(/^import\s+(.+?)\s+from\s+["']([^"']+)["'];?$/);
    if (importMatch) {
      const importClause = importMatch[1].trim();
      const modulePath = importMatch[2];
      // 生成唯一的变量名
      const varName = '__dep_' + modulePath.replace(/[@\/\-\.]/g, '_').replace(/^_+/, '');
      requireDecls.push(`var ${varName} = require(${JSON.stringify(modulePath)});`);

      // 解析导入，在后续代码中替换引用
      if (importClause.startsWith('{')) {
        // 命名导入: { a, b as c }
        const names = importClause.replace(/[{}]/g, '').split(',').map(s => s.trim()).filter(Boolean);
        for (const name of names) {
          const parts = name.split(/\s+as\s+/);
          const imported = parts[0].trim();
          const local = (parts[1] || parts[0]).trim();
          if (local === imported) {
            filteredLines.push(`var ${local} = ${varName}.${imported};`);
          } else {
            filteredLines.push(`var ${local} = ${varName}.${imported};`);
          }
        }
      } else if (importClause.includes('{')) {
        // 混合导入: defaultName, { a, b }
        const [defaultPart, namedPart] = importClause.split('{');
        const defaultName = defaultPart.replace(/,$/, '').trim();
        filteredLines.push(`var ${defaultName} = ${varName}.default !== undefined ? ${varName}.default : ${varName};`);
        const names = namedPart.replace(/[}]/g, '').split(',').map(s => s.trim()).filter(Boolean);
        for (const name of names) {
          const parts = name.split(/\s+as\s+/);
          const imported = parts[0].trim();
          const local = (parts[1] || parts[0]).trim();
          filteredLines.push(`var ${local} = ${varName}.${imported};`);
        }
      } else {
        // 默认导入
        const defaultName = importClause;
        filteredLines.push(`var ${defaultName} = ${varName}.default !== undefined ? ${varName}.default : ${varName};`);
      }
    } else {
      filteredLines.push(line);
    }
  }
  body = filteredLines.join('\n');

  // 2. 转换 export 语句
  // export { a, b, c }; -> exports.a = a; exports.b = b; exports.c = c;
  body = body.replace(/^export\s*\{([^}]+)\}\s*;?\s*$/gm, (match, names) => {
    return names.split(',').map(s => {
      const parts = s.trim().split(/\s+as\s+/);
      const local = parts[0].trim();
      const exported = (parts[1] || parts[0]).trim();
      return `exports.${exported} = ${local};`;
    }).join('\n');
  });

  // export const/let/var/function/class xxx -> const/let/var/function/class xxx
  body = body.replace(/^export\s+(const|let|var|function|class)\s+/gm, '$1 ');

  // 3. 清理 sourcemap 注释
  body = body.replace(/^\/\/# sourceMappingURL=.*$/gm, '').trim();

  // 4. 构建最终输出
  const output = `window.__ModuleLoader__.load({
\tid: "dsh-mobile-sync",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${requireDecls.map(l => '\t\t' + l).join('\n')}
${body.split('\n').map(l => '\t\t' + l).join('\n')}
\t\treturn module.exports;
\t}
});
`;

  await writeFile(clientPath, output, 'utf-8');
  console.log('✓ client.js wrapped into DSH ModuleLoader format');
  console.log(`  require declarations: ${requireDecls.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
