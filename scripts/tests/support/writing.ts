import { writingModel } from '../../writing.ts';

export const eventStream = (response: string, model = writingModel) =>
  [
    { event: 'init', init: { model } },
    { event: 'result', result: { status: 'SUCCESS', response } },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n');
