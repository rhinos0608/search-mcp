import { stdin, stdout } from 'node:process';
import { parsePdf } from './pdf.js';
import { parseOffice } from './office.js';

let input = '';
stdin.setEncoding('utf8');
stdin.on('data', (chunk: string | Buffer) => {
  input += chunk.toString();
});
stdin.on('end', () => {
  void (async () => {
    try {
      const request = JSON.parse(input) as { kind: 'pdf' | 'office'; ext?: string; data: string };
      const bytes = Buffer.from(request.data, 'base64');
      const result =
        request.kind === 'pdf'
          ? await parsePdf(bytes)
          : await parseOffice(bytes, request.ext ?? '.docx');
      stdout.write(
        JSON.stringify({
          markdown: result.markdown,
          title: result.title,
          tables: result.tables,
          warnings: result.warnings,
          images: result.images.map((image) => ({
            mime: image.mime,
            page: image.page,
            data: Buffer.from(image.data).toString('base64'),
          })),
        }),
      );
    } catch (error) {
      stdout.write(
        JSON.stringify({ error: error instanceof Error ? error.message : 'parser failed' }),
      );
      process.exitCode = 1;
    }
  })();
});
