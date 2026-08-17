// Commands: styles — what an agent has to read before it can use textStyle=
import chalk from 'chalk';
import {
  program,
  checkConnection,
  fastEval
} from '../lib/cli-core.js';

// ============ STYLE COMMANDS ============

// Local styles plus the remote (library) styles the document already uses.
// Remote styles have no name-addressable lookup in the Plugin API, so the ones
// in use are the only ones anybody can reference — same set the renderer
// resolves `textStyle=` against.
const LIST_TEXT_STYLES = `(async () => {
  const local = await figma.getLocalTextStylesAsync();
  const out = local.map(s => ({
    name: s.name, family: s.fontName.family, weight: s.fontName.style,
    size: s.fontSize, remote: false,
  }));
  const known = new Set(local.map(s => s.id));
  try {
    const texts = figma.currentPage.findAllWithCriteria({ types: ['TEXT'] });
    const ids = new Set();
    for (const t of texts) {
      const id = t.textStyleId;
      if (typeof id === 'string' && id && !known.has(id)) ids.add(id);
    }
    for (const id of ids) {
      const st = await figma.getStyleByIdAsync(id);
      if (st && st.fontName) {
        out.push({
          name: st.name, family: st.fontName.family, weight: st.fontName.style,
          size: st.fontSize, remote: true,
        });
      }
    }
  } catch (e) {}
  return out;
})()`;

program
  .command('styles')
  .description('List the text styles of the current file (use the names with textStyle= in JSX)')
  .option('--json', 'Raw JSON output')
  .action(async (options) => {
    await checkConnection();

    const styles = await fastEval(LIST_TEXT_STYLES);
    const list = Array.isArray(styles) ? styles : [];

    if (options.json) {
      console.log(JSON.stringify(list, null, 2));
      return;
    }

    if (list.length === 0) {
      console.log(chalk.yellow('No text styles in this file.'));
      console.log(chalk.gray('Rendered text keeps its own font/size props — nothing to bind to.'));
      return;
    }

    const width = Math.max(...list.map(s => s.name.length));
    for (const s of list) {
      const meta = `${s.family} ${s.weight} ${s.size}px`;
      console.log(
        chalk.cyan(s.name.padEnd(width)) + '  ' +
        chalk.gray(meta) + (s.remote ? chalk.gray(' (library)') : '')
      );
    }
    console.log(chalk.gray(`\n${list.length} text styles. Use them as `) +
      chalk.white('<Text textStyle="' + list[0].name + '">') +
      chalk.gray(' — the part after the last "/" works too.'));
  });
