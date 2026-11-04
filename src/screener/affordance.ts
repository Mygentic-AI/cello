// How the local security layer marks its own words. Inbound text can't carry this marker, because the sanitizer removes it.
export const AFFORDANCE_PREFIX = "[cello security layer, local]";
