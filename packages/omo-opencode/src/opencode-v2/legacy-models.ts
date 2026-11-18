import { record, string } from "./legacy-messages"

function npmPackage(value: unknown): string | undefined {
  const name = string(value)
  return name?.startsWith("aisdk:") ? name.slice("aisdk:".length) : name
}

/** Models are projected only for V1 consumers. Native registration keeps its own
 * source definitions: boolean modality maps are not valid native capabilities. */
export function toLegacyModel(value: unknown, provider?: unknown): Record<string, unknown> {
  const source = record(value)
  const owner = record(provider)
  const capabilities = record(source.capabilities)
  const input = Array.isArray(capabilities.input)
    ? capabilities.input.filter((item): item is string => typeof item === "string")
    : []
  const output = Array.isArray(capabilities.output)
    ? capabilities.output.filter((item): item is string => typeof item === "string")
    : []
  const variants = Array.isArray(source.variants)
    ? Object.fromEntries(
        source.variants.map((value) => {
          const variant = record(value)
          return [String(variant.id), { ...variant, ...record(variant.settings), ...record(variant.body) }]
        }),
      )
    : record(source.variants)
  const prices = Array.isArray(source.cost) ? source.cost : []
  const baseCost = record(prices.find((price) => record(price).tier === undefined) ?? prices[0])
  const cache = record(baseCost.cache)
  const npm = npmPackage(source.package ?? owner.package ?? owner.npm)
  return {
    ...source,
    providerID: source.providerID ?? owner.id,
    api: { ...record(source.api), id: source.modelID ?? source.id, ...(npm ? { npm } : {}) },
    ...(npm ? { provider: { ...record(source.provider), npm } } : {}),
    modalities: { input, output },
    capabilities: {
      ...capabilities,
      toolcall: capabilities.tools,
      input: Object.fromEntries(input.map((item) => [item, true])),
      output: Object.fromEntries(output.map((item) => [item, true])),
    },
    tool_call: capabilities.tools,
    attachment: input.some((item) => item !== "text"),
    ...(typeof capabilities.temperature === "boolean" ? { temperature: capabilities.temperature } : {}),
    variants,
    options: { ...record(source.settings) },
    ...(prices.length ? { cost: { ...baseCost, cache_read: cache.read, cache_write: cache.write } } : {}),
  }
}
