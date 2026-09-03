/** @file Outcome: Every model response schema is accepted before an API request starts. */

import { FlowError } from './errors.ts';
import { isObject } from './schema.ts';

/** Reusable model-output primitives that match the runtime's non-blank string contract. */
export const NON_BLANK_STRING_SCHEMA = { type: 'string', pattern: '\\S' } as const;

function visit(schema: unknown, location: string): void {
  if (!isObject(schema)) return;
  if (schema.properties !== undefined) {
    if (schema.type !== 'object' || !isObject(schema.properties)) {
      throw new FlowError(`${location} properties require an object schema`, 'schema_error');
    }
    if (schema.additionalProperties !== false) {
      throw new FlowError(`${location} must set additionalProperties to false`, 'schema_error');
    }
    if (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== 'string')) {
      throw new FlowError(`${location} must declare required object fields`, 'schema_error');
    }
    const properties = Object.keys(schema.properties);
    const required = schema.required as string[];
    if (
      required.length !== properties.length ||
      properties.some((key) => !required.includes(key)) ||
      required.some((key) => !Object.hasOwn(schema.properties as object, key))
    ) {
      throw new FlowError(`${location} required fields must equal its properties`, 'schema_error');
    }
    for (const [key, value] of Object.entries(schema.properties)) {
      visit(value, `${location}.properties.${key}`);
    }
  }
  if (schema.items !== undefined) visit(schema.items, `${location}.items`);
  if (Array.isArray(schema.anyOf)) {
    schema.anyOf.forEach((value, index) => visit(value, `${location}.anyOf[${index}]`));
  }
}

export function assertStructuredOutputSchema(schema: unknown): void {
  if (!isObject(schema) || schema.type !== 'object' || schema.anyOf !== undefined) {
    throw new FlowError('model response schema root must be an object', 'schema_error');
  }
  visit(schema, '$');
}
