/**
 * Body field mappings for TreeSitter AST nodes.
 *
 * Maps language -> node type -> body field name
 * - string: The field name containing the body to elide
 * - null: Node type has no body to elide (e.g., type aliases, interfaces)
 * - undefined: Node type not recognized for this language
 *
 * IMPORTANT: Classes are "containers" - we don't elide their bodies,
 * we recurse into them to skeletonize individual methods.
 */

export const BODY_FIELDS: Record<string, Record<string, string | null>> = {
  typescript: {
    function_declaration: "body",
    method_definition: "body",
    arrow_function: "body",
    generator_function_declaration: "body",
    // Classes are containers - don't elide, recurse into them
    class_declaration: null,
    interface_declaration: null, // Interfaces have no body to elide - keep as-is
    type_alias_declaration: null, // Type aliases are already compact
    enum_declaration: null, // Enums are already compact
  },

  tsx: {
    // Same as typescript
    function_declaration: "body",
    method_definition: "body",
    arrow_function: "body",
    generator_function_declaration: "body",
    class_declaration: null, // Container
    interface_declaration: null,
    type_alias_declaration: null,
    enum_declaration: null,
  },

  javascript: {
    // Same as typescript (uses tsx grammar)
    function_declaration: "body",
    method_definition: "body",
    arrow_function: "body",
    generator_function_declaration: "body",
    class_declaration: null, // Container
  },

  python: {
    function_definition: "body",
    class_definition: null, // Container - recurse into methods
  },

  go: {
    function_declaration: "body",
    method_declaration: "body",
    type_declaration: null, // Type declarations are compact
  },

  rust: {
    function_item: "body",
    impl_item: null, // Container - recurse into methods
    trait_item: null, // Trait definitions show method signatures - keep as-is
    struct_item: null, // Struct definitions are compact
    enum_item: null, // Enum definitions are compact
    mod_item: "body",
  },

  java: {
    method_declaration: "body",
    constructor_declaration: "body",
    class_declaration: null, // Container
    interface_declaration: null,
    enum_declaration: null,
  },

  c_sharp: {
    method_declaration: "body",
    constructor_declaration: "body",
    class_declaration: null, // Container
    interface_declaration: null,
    struct_declaration: null, // Container
    namespace_declaration: null,
  },

  cpp: {
    function_definition: "body",
    class_specifier: null, // Container
    struct_specifier: null, // Container
    namespace_definition: null, // Container
    enum_specifier: null,
  },

  c: {
    function_definition: "body",
    struct_specifier: null,
    enum_specifier: null,
  },

  ruby: {
    method: "body",
    class: null, // Container
    module: null, // Container
    singleton_method: "body",
  },

  php: {
    function_definition: "body",
    method_declaration: "body",
    class_declaration: null, // Container
    interface_declaration: null,
    trait_declaration: null, // Container
  },

  swift: {
    function_declaration: "body",
    init_declaration: "body",
    deinit_declaration: "body",
    class_declaration: null, // Container (covers class/struct/enum/actor)
    protocol_declaration: null, // Container
    enum_class_body: null, // Container for nested declarations
  },
};

/**
 * Container types - these hold methods/functions but shouldn't be elided themselves.
 * We recurse into them to skeletonize their contents.
 */
export const CONTAINER_TYPES: Record<string, string[]> = {
  typescript: ["class_declaration", "class_body"],
  tsx: ["class_declaration", "class_body"],
  javascript: ["class_declaration", "class_body"],
  python: ["class_definition"],
  go: [], // Go doesn't have classes
  rust: ["impl_item"],
  java: ["class_declaration", "class_body"],
  c_sharp: ["class_declaration", "struct_declaration", "class_body"],
  cpp: ["class_specifier", "struct_specifier"],
  c: [],
  ruby: ["class", "module"],
  php: ["class_declaration", "trait_declaration"],
  swift: ["class_declaration", "class_body", "enum_class_body", "protocol_declaration", "protocol_body"],
};

/**
 * Check if a node type is a container (holds methods).
 */
export function isContainerType(langId: string, nodeType: string): boolean {
  return CONTAINER_TYPES[langId]?.includes(nodeType) ?? false;
}

/**
 * Get the body field name for a given language and node type.
 *
 * @returns string - Field name to access body
 * @returns null - Node has no body to elide (keep as-is)
 * @returns undefined - Node type not recognized
 */
export function getBodyField(
  langId: string,
  nodeType: string,
): string | null | undefined {
  return BODY_FIELDS[langId]?.[nodeType];
}

/**
 * Check if a node type has a body that can be elided.
 */
export function hasBodyField(langId: string, nodeType: string): boolean {
  const field = getBodyField(langId, nodeType);
  return typeof field === "string";
}

/**
 * Check if a node type should be kept as-is (no elision).
 * These are typically type definitions, interfaces, etc.
 */
export function shouldPreserveWhole(langId: string, nodeType: string): boolean {
  const field = getBodyField(langId, nodeType);
  return field === null;
}
