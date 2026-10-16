import { defineEnvVars } from '@sveltejs/kit/env'

// Private (server-only) variables, read in src/lib/server/openramp.ts through `$app/env/private`.
export const variables = defineEnvVars({
  OPENRAMP_SECRET: {
    description: '32+ random characters',
    schema: (value) => value || 'dev-secret-change-me-dev-secret-change-me',
  },
  PUBLIC_URL: {
    description: 'The public origin of this app. The OpenRampKit `baseUrl` is PUBLIC_URL + /api/openramp.',
    schema: (value) => value || 'http://localhost:3000',
  },
})
