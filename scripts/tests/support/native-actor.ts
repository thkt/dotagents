import { mkdtemp, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

// native producer自身が原記録を作る。外部Codexだけを有限の模擬コマンドへ置換する。
export async function nativeActorEnvironment(root: string, actors: Record<string, string[]>) {
  const bin = await mkdtemp(join(root, 'fixture-native-bin-'));
  await writeFile(
    join(bin, 'codex'),
    `#!${process.execPath}
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
if(process.argv[2]==='--version') {console.log('fixture-codex 1');process.exit(0);}
const args=process.argv.slice(2);
if(args[0]!=='exec'||process.env.DOTAGENTS_ACTOR_PREFIX!==undefined) throw Error('fixture: native invocation contract');
const final=args[args.indexOf('-o')+1];
const actor=JSON.parse(readFileSync(join(dirname(final),'actor.json'),'utf8'));
const command=${JSON.stringify(actors)}[actor.role];
if(!command) throw Error('fixture: unexpected native role');
const prompt=readFileSync(0,'utf8');
writeFileSync(join(dirname(final),'fixture-invocation.json'),JSON.stringify({prompt,cwd:process.cwd(),role:actor.role}));
const result=spawnSync(command[0],command.slice(1),{input:prompt,encoding:'utf8',timeout:10000});
if(result.error) throw result.error;
if(result.status!==0) {process.stderr.write(result.stderr);process.exit(result.status??1);}
const reply=result.stdout.trim();
JSON.parse(reply);
writeFileSync(final,reply);
process.stdout.write([
 {type:'thread.started',thread_id:'fixture-native-'+randomUUID()},
 {type:'turn.started'},
 {type:'item.completed',item:{type:'agent_message',text:reply}},
 {type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:0,output_tokens:5}}
].map(event=>JSON.stringify(event)).join('\\n')+'\\n');
`,
    { mode: 0o755 },
  );
  return { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` };
}
