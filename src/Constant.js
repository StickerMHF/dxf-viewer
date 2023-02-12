/** Point display mode, $PDMODE system variable. */
export const PdMode = Object.freeze({
    DOT: 0,
    NONE: 1,
    PLUS: 2,
    CROSS: 3,
    TICK: 4,
    MARK_MASK: 0xf,

    CIRCLE: 0x20,
    SQUARE: 0x40,

    SHAPE_MASK: 0xf0
})

/** Special color values, used for block entities. Regular entities color is resolved instantly. */
export const ColorCode = Object.freeze({
    BY_LAYER: -1,
    BY_BLOCK: -2
})
/** Use 16-bit indices for indexed geometry. */
export const INDEXED_CHUNK_SIZE = 0x10000
/** Arc angle for tessellating point circle shape. */
export const POINT_CIRCLE_TESSELLATION_ANGLE = 15 * Math.PI / 180
export const POINT_SHAPE_BLOCK_NAME = "__point_shape"
/** Flatten a block if its total vertices count in all instances is less than this value. */
export const BLOCK_FLATTENING_VERTICES_THRESHOLD = 1024
/** Number of subdivisions per spline point. */
export const SPLINE_SUBDIVISION = 4
/** Regex for parsing special characters in text entities. */
export const SPECIAL_CHARS_RE = /(?:%%([dpc]))|(?:\\U\+([0-9a-fA-F]{4}))/g