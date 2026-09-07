import { stdin, stdout } from 'node:process';

const mode = process.argv[2] ?? 'success';
if (mode === 'hang') setInterval(() => {}, 1000);
let input = '';
stdin.setEncoding('utf8');
stdin.on('data', (chunk: string) => {
  input += chunk;
});
stdin.on('end', () => {
  if (mode === 'malformed') {
    stdout.write('{bad');
    return;
  }
  if (mode === 'overflow') {
    stdout.write('x'.repeat(10000));
    return;
  }
  if (mode === 'oversized') {
    stdout.write(
      JSON.stringify({
        markdown: 'x'.repeat(2000),
        title: '',
        tables: [],
        warnings: [],
        images: [],
      }),
    );
    return;
  }
  const request = JSON.parse(input) as { data: string };
  if (mode === 'exit-nonzero') {
    stdout.write(
      JSON.stringify({ markdown: 'ok', title: '', tables: [], warnings: [], images: [] }),
    );
    process.exitCode = 1;
    return;
  }
  stdout.write(
    JSON.stringify({
      markdown: mode === 'unicode' ? 'é'.repeat(1000) : 'ok',
      title: '',
      tables: [],
      warnings: [],
      images:
        mode === 'image'
          ? [
              {
                mime: 'image/png',
                page: 1,
                data: Buffer.from('image'.repeat(1000)).toString('base64'),
              },
            ]
          : [],
      inputBytes: Buffer.from(request.data, 'base64').length,
    }),
  );
});
