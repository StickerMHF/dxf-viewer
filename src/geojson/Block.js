import {BlockContext} from "./BlockContext.js";
import {BLOCK_FLATTENING_VERTICES_THRESHOLD} from "../Constant";
export class Block {
    /** @param data {{}} Raw DXF entity. */
    constructor(data) {
        this.data = data
        /* Number of times referenced from top-level entities (INSERT). */
        this.useCount = 0
        /* Number of times referenced by other block. */
        this.nestedUseCount = 0
        /* Total number of vertices in this block. Used for flattening decision. */
        this.verticesCount = 0
        /* Offset {x, y} to apply for all vertices. Used to move origin near vertices location to
         * minimize precision loss.
         */
        this.offset = null
        /* Definition batches. Used for root blocks flattening. */
        this.batches = []
        this.flatten = false
        /** Bounds in block coordinates (with offset applied). */
        this.bounds = null
    }

    /** Set block flattening flag based on usage statistics.
     * @return {Boolean} New flatten flag state.
     */
    SetFlatten() {
        if (!this.HasGeometry()) {
            return false
        }
        /* Flatten if a block is used once (pure optimization if shares its layer with other
         * geometry) or if total instanced vertices number is less than a threshold (trade some
         * space for draw calls number).
         */
        this.flatten = this.useCount === 1 ||
                       this.useCount * this.verticesCount <= BLOCK_FLATTENING_VERTICES_THRESHOLD
        return this.flatten
    }

    /** @return {Boolean} True if has something to draw. */
    HasGeometry() {
        /* Offset is set on first geometry vertex encountered. */
        return this.offset !== null
    }

    RegisterInsert(entity) {
        this.useCount++
    }

    RegisterNestedUse(usedByBlock) {
        this.nestedUseCount++
    }

    /** @return {BlockContext} Context for block definition. */
    DefinitionContext() {
        return new BlockContext(this, BlockContext.Type.DEFINITION)
    }

    InstantiationContext() {
        return new BlockContext(this, BlockContext.Type.INSTANTIATION)
    }

    UpdateBounds(v) {
        if (this.bounds === null) {
            this.bounds = { minX: v.x, maxX: v.x, minY: v.y, maxY: v.y }
        } else {
            if (v.x < this.bounds.minX) {
                this.bounds.minX = v.x
            } else if (v.x > this.bounds.maxX) {
                this.bounds.maxX = v.x
            }
            if (v.y < this.bounds.minY) {
                this.bounds.minY = v.y
            } else if (v.y > this.bounds.maxY) {
                this.bounds.maxY = v.y
            }
        }
    }
}