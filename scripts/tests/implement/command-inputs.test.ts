import { expect, test } from 'bun:test';
import { commandInputs } from '../../implement/command-inputs.ts';

test('line continuations preserve comment and quoted word boundaries', () => {
  const cases: [string, string[], boolean][] = [
    ['cat \\\n# comment.md', [], true],
    ['cat \\\nfile.md', ['file.md'], false],
    ['cat a.txt\\\n#part.md', ['a.txt#part.md'], false],
    ['cat ""\\\n#part.md', ['#part.md'], false],
    ["cat 'a\\\n#part.md'", ['a\\\n#part.md'], false],
    ['cat "a\\\n#part.md"', ['a#part.md'], false],
    ['cat \\"\\\n#part.md', ['"#part.md'], false],
    ['cat # comment\\\ncat next.md', ['next.md'], true],
  ];
  for (const [command, paths, partial] of cases) {
    expect(commandInputs(command), command).toEqual({ paths, partial });
  }
});

test('clobber redirects never turn destinations into read commands', () => {
  const cases: [string, string[], boolean][] = [
    ['echo hello >|cat fake.md', [], true],
    ['echo hi >| cat out.txt; cat real.md', ['real.md'], true],
    ['cat real.md 1>|cat', ['real.md'], false],
    ['echo hello >\\\n|cat fake.md; cat real.md', ['real.md'], true],
    ['echo hello | cat real.md > out.txt', ['real.md'], true],
    ['echo hi >>| cat fake.md', [], true],
    ["/bin/zsh -lc 'echo hi >>| cat fake.md; cat real.md'", ['real.md'], true],
    ['cat real.md 1>>|cat', ['real.md'], false],
    ['echo hi >>\\\n|cat fake.md; cat real.md', ['real.md'], true],
    ['echo hi >> cat fake.md | cat real.md', ['real.md'], true],
  ];
  for (const [command, paths, partial] of cases) {
    expect(commandInputs(command), command).toEqual({ paths, partial });
  }
});

test('zsh command-path expansion is unknown while quoted and escaped equals stay literal', () => {
  for (const command of [
    'cat =sh',
    "/bin/zsh -c 'cat =sh'",
    'cat =sh; cat real.md',
    "cat ''=sh",
    'cat ""=sh',
  ]) {
    expect(commandInputs(command), command).toEqual({ paths: [], partial: true });
  }
  for (const command of ["cat '=sh'", 'cat "=sh"', 'cat \\=sh']) {
    expect(commandInputs(command), command).toEqual({ paths: ['=sh'], partial: false });
    expect(commandInputs(`/bin/zsh -c '${command.replaceAll("'", "'\\''")}'`), command).toEqual({
      paths: ['=sh'],
      partial: false,
    });
  }
  expect(commandInputs('cat dir/=sh name=value.md')).toEqual({
    paths: ['dir/=sh', 'name=value.md'],
    partial: false,
  });
});

test('commands containing carriage returns are unknown, not silently corrected paths', () => {
  for (const command of ['cat a.txt\r', 'cat a.txt\r\ncat b.txt', "cat 'a\r.txt'"]) {
    expect(commandInputs(command), command).toEqual({ paths: [], partial: true });
  }
  expect(commandInputs('cat a.txt \t b.txt')).toEqual({
    paths: ['a.txt', 'b.txt'],
    partial: false,
  });
});
