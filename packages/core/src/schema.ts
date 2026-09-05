import type { JsonObject } from './types.js'

/** Portable tool-schema subset. Supply Tool.validate for formats or custom vocabularies. */
export function validateArguments(value: unknown, schema: JsonObject, path = '$', depth = 0): void {
  if (depth > 64) throw new Error('Tool arguments exceed maximum nesting depth.')
  const fail = (message: string): never => { throw new Error(`${path}: ${message}`) }
  if (schema.$ref) fail('$ref requires a custom Tool.validate implementation')
  if (Array.isArray(schema.enum) && !schema.enum.some(item => equal(item, value))) fail('value is not in enum')
  if ('const' in schema && !equal(schema.const, value)) fail('value does not match const')
  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (!Array.isArray(schema[keyword])) continue
    const variants = schema[keyword] as JsonObject[]
    const matches = variants.filter(variant => { try { validateArguments(value, variant, path, depth + 1); return true } catch { return false } }).length
    if (keyword === 'allOf' ? matches !== variants.length : keyword === 'oneOf' ? matches !== 1 : matches === 0) fail(`does not satisfy ${keyword}`)
  }
  const types = typeof schema.type === 'string' ? [schema.type] : Array.isArray(schema.type) ? schema.type : []
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  if (types.length && !types.some(type => type === actual || type === 'integer' && Number.isInteger(value))) fail(`expected ${types.join('|')}`)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('number must be finite')
    if (typeof schema.minimum === 'number' && value < schema.minimum) fail('below minimum')
    if (typeof schema.maximum === 'number' && value > schema.maximum) fail('above maximum')
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) fail('string too short')
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) fail('string too long')
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) fail('string does not match pattern')
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) fail('too few items')
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) fail('too many items')
    if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) value.forEach((item, index) => validateArguments(item, schema.items as JsonObject, `${path}[${index}]`, depth + 1))
  } else if (value && typeof value === 'object') {
    const record = value as JsonObject
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties as JsonObject : {}
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof key === 'string' && !Object.hasOwn(record, key)) fail(`missing required property ${key}`)
    }
    for (const [key, item] of Object.entries(record)) {
      if (Object.hasOwn(properties, key)) validateArguments(item, properties[key] as JsonObject, `${path}.${key}`, depth + 1)
      else if (schema.additionalProperties === false) fail(`unknown property ${key}`)
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validateArguments(item, schema.additionalProperties as JsonObject, `${path}.${key}`, depth + 1)
    }
  }
}
function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b) }
