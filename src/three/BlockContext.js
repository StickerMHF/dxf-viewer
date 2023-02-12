import {Matrix3, Vector2} from "three"
export class BlockContext {
    constructor(block, type) {
        this.block = block
        this.type = type
        this.origin = this.block.data.position
        /* Transform to apply for block definition entities not including block offset. */
        this.transform = new Matrix3()
    }

    /** @return {string} Block name */
    get name() {
        return this.block.data.name
    }

    /**
     * @param v {{x,y}}
     * @return {{x,y}}
     */
    TransformVertex(v) {
        const result = new Vector2(v.x, v.y).applyMatrix3(this.transform)
        if (this.type !== BlockContext.Type.DEFINITION &&
            this.type !== BlockContext.Type.NESTED_DEFINITION) {

            throw new Error("Unexpected transform type")
        }
        this.block.verticesCount++
        if (this.block.offset === null) {
            /* This is the first vertex. Take it as a block origin. So the result is always zero
             * vector for the first vertex.
             */
            this.block.offset = result
            const v = new Vector2()
            this.block.UpdateBounds(v)
            return v
        }
        result.sub(this.block.offset)
        this.block.UpdateBounds(result)
        return result
    }

    /**
     * Get transform for block instance.
     * @param entity Raw DXF INSERT entity.
     * @return {Matrix3} Transform matrix for block instance to apply to the block definition.
     */
    GetInsertionTransform(entity) {
        const mInsert = new Matrix3().translate(-this.origin.x, -this.origin.y)
        const yScale = entity.yScale || 1
        const xScale = entity.xScale || 1
        const rotation = -(entity.rotation || 0) * Math.PI / 180
        let x = entity.position.x
        const y = entity.position.y
        mInsert.scale(xScale, yScale)
        mInsert.rotate(rotation)
        mInsert.translate(x, y)
        if (entity.extrusionDirection && entity.extrusionDirection.z < 0) {
            mInsert.scale(-1, 1)
        }
        if (this.type !== BlockContext.Type.INSTANTIATION) {
            return mInsert
        }
        const mOffset = new Matrix3().translate(this.block.offset.x, this.block.offset.y)
        return mInsert.multiply(mOffset)
    }

    /**
     * Create context for nested block.
     * @param block {Block} Nested block.
     * @param entity Raw DXF INSERT entity.
     * @return {BlockContext} Context to use for nested block entities.
     */
    NestedBlockContext(block, entity) {
        block.RegisterNestedUse(this.block)
        const nestedCtx = new BlockContext(block, BlockContext.Type.NESTED_DEFINITION)
        const nestedTransform = nestedCtx.GetInsertionTransform(entity)
        const ctx = new BlockContext(this.block, BlockContext.Type.NESTED_DEFINITION)
        ctx.transform = new Matrix3().multiplyMatrices(this.transform, nestedTransform)
        return ctx
    }
}

BlockContext.Type = Object.freeze({
    DEFINITION: 0,
    NESTED_DEFINITION: 1,
    INSTANTIATION: 2
})