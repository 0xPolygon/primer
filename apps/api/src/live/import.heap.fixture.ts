// Run by import.test.ts in a child process with a capped heap: imports a large
// Markdown file (about 2,000 blocks) and prints the block count.
import { importMarkdown } from './import.ts';

let source = '';
for (let i = 0; i < 400; i++) {
  source += `## Section ${i}\n\nParagraph ${i} with **bold** and a [link](https://example.com/${i}).\n\n`;
  source += `- item one ${i}\n- item two\n- item three\n\n| a | b |\n|---|---|\n| ${i} | x |\n\n`;
}
const { blocks } = await importMarkdown(source);
console.log(blocks.length);
