/**
 * Route descriptors — the single list of what the API exposes.
 *
 * The API registers handlers against these paths; the web client builds URLs from
 * them. Neither side hand-writes a path string, so a rename breaks the build on both
 * ends at once instead of 404-ing at runtime.
 */
export const routes = {
  properties: {
    list: () => '/v1/properties',
    create: () => '/v1/properties',
    get: (id: string) => `/v1/properties/${id}`,
    update: (id: string) => `/v1/properties/${id}`,
    remove: (id: string) => `/v1/properties/${id}`,
  },
  units: {
    list: (propertyId: string) => `/v1/properties/${propertyId}/units`,
    create: (propertyId: string) => `/v1/properties/${propertyId}/units`,
    get: (id: string) => `/v1/units/${id}`,
    update: (id: string) => `/v1/units/${id}`,
    remove: (id: string) => `/v1/units/${id}`,
  },
} as const;
