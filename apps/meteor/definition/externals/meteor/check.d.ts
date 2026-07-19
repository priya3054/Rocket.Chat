import 'meteor/check';
import type { Meteor } from 'meteor/meteor';

declare module 'meteor/check' {
	namespace Match {
		function Where<T, U extends T>(condition: (val: T) => val is U): Matcher<U>;

		// Not declared by @types/meteor even though it exists at runtime (packages/check/match.js
		// in Meteor core) -- thrown by check() for an unrecognized/extra key. Carries its own
		// sanitized Meteor.Error(400, ...) specifically meant to be surfaced to callers instead of
		// leaking a raw Match.Error as an internal error.
		class Error extends globalThis.Error {
			path: string;
			sanitizedError: Meteor.Error;
		}
	}
}
