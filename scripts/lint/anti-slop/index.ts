import { definePlugin } from '@oxlint/plugins';
import { noReduceAccumulatorCopyRule } from './rules/no-reduce-accumulator-copy.ts';

export default definePlugin({
  meta: { name: 'anti-slop' },
  rules: { 'no-reduce-accumulator-copy': noReduceAccumulatorCopyRule },
});
