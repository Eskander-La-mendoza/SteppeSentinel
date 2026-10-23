export const openApiDocument = {
  openapi: "3.1.0",
  info: { title: "Steppe Sentinel API", version: "1.1.0", description: "Role-protected pasture monitoring, Sentinel-2 indices and post-spectral ML." },
  servers: [{ url: "http://localhost:4000" }],
  tags: [{ name: "Authentication" }, { name: "Administration" }, { name: "Pastures" }, { name: "Satellite" }, { name: "NDVI" }, { name: "Machine Learning" }, { name: "Jobs" }],
  components: { securitySchemes: { sessionCookie: { type: "apiKey", in: "cookie", name: "steppe_sentinel_session" } } },
  security: [{ sessionCookie: [] }],
  paths: {
    "/api/auth/register": { post: { security: [], tags: ["Authentication"], summary: "Register a client account", responses: { "201": { description: "Registered" }, "409": { description: "Email already exists" } } } },
    "/api/auth/login": { post: { security: [], tags: ["Authentication"], summary: "Create an HttpOnly session", responses: { "200": { description: "Signed in" }, "401": { description: "Invalid credentials" } } } },
    "/api/auth/logout": { post: { tags: ["Authentication"], summary: "Destroy the current session", responses: { "204": { description: "Signed out" } } } },
    "/api/auth/me": { get: { tags: ["Authentication"], summary: "Get the current user", responses: { "200": { description: "Current user" }, "401": { description: "Authentication required" } } } },
    "/api/admin/users": { get: { tags: ["Administration"], summary: "List users (ADMIN only)", responses: { "200": { description: "Users" }, "403": { description: "Administrator role required" } } } },
    "/api/pastures": {
      get: { tags: ["Pastures"], summary: "List pastures", responses: { "200": { description: "Pastures" } } },
      post: { tags: ["Pastures"], summary: "Create a pasture from GeoJSON", responses: { "201": { description: "Created" }, "422": { description: "Invalid geometry" } } }
    },
    "/api/pastures/{id}/satellite/search": { post: { tags: ["Satellite"], summary: "Queue May–September Sentinel-2 search", responses: { "202": { description: "Queued" } } } },
    "/api/pastures/{id}/ndvi/process": { post: { tags: ["NDVI"], summary: "Queue NDVI processing for selected scenes", responses: { "202": { description: "Queued" } } } },
    "/api/ml/train": { post: { tags: ["Machine Learning"], summary: "Queue Random Forest training", responses: { "202": { description: "Queued" } } } },
    "/api/jobs/{id}": { get: { tags: ["Jobs"], summary: "Get background job state", responses: { "200": { description: "Job" } } } }
  }
};
