import { ajv } from '@rocket.chat/rest-typings';

import { API } from '../api';

// Specmatic cross-references an OpenAPI spec against the app's real, live routes to report
// accurate "not implemented" (in the spec but never built) vs "missing in spec" (built but
// undocumented) coverage results, instead of only inferring coverage from which tests ran.
// It does this via `actuatorUrl` in specmatic.yaml, which it expects to serve routes in the
// same JSON shape as Spring Boot's own /actuator/mappings endpoint (the de facto standard this
// tooling adopted -- Specmatic's own ready-made Flask/Sanic/FastAPI coverage servers all target
// this exact shape: contexts.application.mappings.dispatcherServlets.dispatcherServlet[].
// details.requestMappingConditions.{methods,patterns}). Rocket.Chat has no built-in actuator
// (it isn't a Spring app), so this reuses the same route data `GET /api/docs/json` already
// exposes (`API.api.typedRoutes`, populated once every endpoint file has registered its routes)
// and reshapes it into that format, rather than building new route introspection from scratch.
//
// RocketChat's own path parameters are Hono/Express-style (`:id`), but the OpenAPI specs (and
// Spring's own convention) use `{id}` -- converted here so Specmatic can actually match a given
// spec path against the corresponding real route instead of treating every parameterized path
// as a mismatch.
const toOpenApiStylePath = (path: string): string => path.replace(/:([A-Za-z0-9_-]+)/g, '{$1}');

type ActuatorMappingsResponse = {
	contexts: {
		application: {
			mappings: {
				dispatcherServlets: {
					dispatcherServlet: {
						details: {
							requestMappingConditions: {
								methods: string[];
								patterns: string[];
							};
						};
					}[];
				};
			};
		};
	};
	success: true;
};

const buildActuatorMappingsResponse = (typedRoutes: Record<string, Record<string, unknown>>): ActuatorMappingsResponse => ({
	contexts: {
		application: {
			mappings: {
				dispatcherServlets: {
					dispatcherServlet: Object.entries(typedRoutes).map(([path, methods]) => ({
						details: {
							requestMappingConditions: {
								methods: Object.keys(methods).map((method) => method.toUpperCase()),
								patterns: [toOpenApiStylePath(path)],
							},
						},
					})),
				},
			},
		},
	},
	success: true,
});

const actuatorMappingsResponseSchema = ajv.compile<ActuatorMappingsResponse>({
	type: 'object',
	properties: {
		contexts: { type: 'object' },
		success: { type: 'boolean', enum: [true] },
	},
	required: ['contexts', 'success'],
	additionalProperties: true,
});

API.default.get(
	'actuator/mappings',
	{
		authRequired: false,
		response: {
			200: actuatorMappingsResponseSchema,
		},
	},
	function action() {
		return API.default.success(buildActuatorMappingsResponse(API.api.typedRoutes));
	},
);
