import {IndexedChunk} from "./IndexedChunk.js";
import {IndexedChunkWriter} from "./IndexedChunkWriter.js";
import {DynamicBuffer, NativeType} from "../DynamicBuffer"
import {INDEXED_CHUNK_SIZE} from "../Constant";
import {BatchingKey} from "../BatchingKey"
import {Matrix3, Vector2} from "three"
export class RenderBatch {
    constructor(key) {
        this.key = key
        if (key.IsIndexed()) {
            this.chunks = []
        } else if (key.geometryType === BatchingKey.GeometryType.BLOCK_INSTANCE) {
            this.transforms = new DynamicBuffer(NativeType.FLOAT32)
        } else {
            this.vertices = new DynamicBuffer(NativeType.FLOAT32)
            this.feature=[];
            this.latlngs=[];
        }
    }

    PushVertex(v) {
        const idx = this.vertices.Push(v.x)
        this.vertices.Push(v.y)
        return idx
    }
    PushLatlng(v) {
        const idx = this.latlngs.push([v.x,v.y])
        return idx
    }
    PushFeature(f) {
        const idx = this.feature.push(f)
        return idx
    }

    /**
     * @param matrix {Matrix3} 3x3 Transform matrix. Assuming 2D affine transform so only top 3x2
     *  sub-matrix is taken.
     */
    PushInstanceTransform(matrix) {
        /* Storing in row-major order as expected by renderer. */
        for (let row = 0; row < 2; row++) {
            for (let col = 0; col < 3; col++) {
                this.transforms.Push(matrix.elements[col * 3 + row])
            }
        }
    }

    /** This method actually reserves space for the specified number of indexed vertices in some
     * chunk. The returned object should be used to push exactly the same amount vertices and any
     * number of their referring indices.
     * @param verticesCount Number of vertices in the chunk.
     * @return {IndexedChunkWriter}
     */
    PushChunk(verticesCount) {
        if (verticesCount > INDEXED_CHUNK_SIZE) {
            throw new Error("Vertices count exceeds chunk limit: " + verticesCount)
        }
        /* Find suitable chunk with minimal remaining space to fill them as fully as possible. */
        let curChunk = null
        let curSpace = 0
        for (const chunk of this.chunks) {
            const space = INDEXED_CHUNK_SIZE - chunk.vertices.GetSize() / 2
            if (space < verticesCount) {
                continue
            }
            if (curChunk === null || space < curSpace) {
                curChunk = chunk
                curSpace = space
            }
        }
        if (curChunk === null) {
            curChunk = this._NewChunk(verticesCount)
        }
        return new IndexedChunkWriter(curChunk, verticesCount)
    }

    /** Merge other batch into this one. They should have the same geometry type. Instanced batches
     * are disallowed.
     *
     * @param batch {RenderBatch}
     * @param transform {?Matrix3} Optional transform to apply for merged vertices.
     */
    Merge(batch, transform = null) {
        if (this.key.geometryType !== batch.key.geometryType) {
            throw new Error("Rendering batch merging geometry type mismatch: " +
                            `${this.key.geometryType} !== ${batch.key.geometryType}`)
        }
        if (this.key.IsInstanced()) {
            throw new Error("Attempted to merge instanced batch")
        }
        if (this.key.IsIndexed()) {
            /* Merge chunks. */
            for (const chunk of batch.chunks) {
                const verticesSize = chunk.vertices.size
                const chunkWriter = this.PushChunk(verticesSize / 2)
                for (let i = 0; i < verticesSize; i += 2) {
                    const v = new Vector2(chunk.vertices.Get(i), chunk.vertices.Get(i + 1))
                    if (transform) {
                        v.applyMatrix3(transform)
                    }
                    chunkWriter.PushVertex(v)
                }
                const numIndices = chunk.indices.size
                for (let i = 0; i < numIndices; i ++) {
                    chunkWriter.PushIndex(chunk.indices.Get(i))
                }
                chunkWriter.Finish()
            }
        } else {
            const n = batch.vertices.size
            for (let i = 0; i < n; i += 2) {
                const v = new Vector2(batch.vertices.Get(i), batch.vertices.Get(i + 1))
                if (transform) {
                    v.applyMatrix3(transform)
                }
                this.PushVertex(v)
            }
        }
    }

    /** @return Vertices buffer required size in bytes. */
    GetVerticesBufferSize() {
        if (this.key.IsIndexed()) {
            let size = 0
            for (const chunk of this.chunks) {
                size += chunk.vertices.GetSize()
            }
            return size * Float32Array.BYTES_PER_ELEMENT
        } else if (this.key.geometryType === BatchingKey.GeometryType.BLOCK_INSTANCE) {
            return 0
        } else {
            return this.vertices.GetSize() * Float32Array.BYTES_PER_ELEMENT
        }
    }

    /** @return Indices buffer required size in bytes. */
    GetIndicesBufferSize() {
        if (this.key.IsIndexed()) {
            let size = 0
            for (const chunk of this.chunks) {
                size += chunk.indices.GetSize()
            }
            return size * Uint16Array.BYTES_PER_ELEMENT
        } else {
            return 0
        }
    }

    /** @return Instances transforms buffer required size in bytes. */
    GetTransformsSize() {
        if (this.key.geometryType === BatchingKey.GeometryType.BLOCK_INSTANCE) {
            return this.transforms.GetSize() * Float32Array.BYTES_PER_ELEMENT
        } else {
            return 0
        }
    }

    Serialize(buffers) {
        if (this.key.IsIndexed()) {
            const batch = {
                key: this.key,
                chunks: []
            }
            for (const chunk of this.chunks) {
                batch.chunks.push(chunk.Serialize(buffers))
            }
            return batch

        } else if (this.key.geometryType === BatchingKey.GeometryType.BLOCK_INSTANCE) {
            const size = this.transforms.GetSize()
            const batch = {
                key: this.key,
                transformsOffset: buffers.transformsOffset,
                transformsSize: size
            }
            this.transforms.CopyTo(buffers.transforms, buffers.transformsOffset)
            buffers.transformsOffset += size
            return batch

        } else {
            const size = this.vertices.GetSize()
            const batch = {
                key: this.key,
                verticesOffset: buffers.verticesOffset,
                verticesSize: size
            }
            this.vertices.CopyTo(buffers.vertices, buffers.verticesOffset)
            buffers.verticesOffset += size
            return batch
        }
    }
    SerializeGeojson() {
        if (this.key.IsIndexed()) {
            const batch = {
                key: this.key,
                chunks: [],
                features:[]
            }
            for (const chunk of this.chunks) {
                // batch.chunks.push(chunk.Serialize(buffers));
                batch.features=batch.features.concat(chunk.SerializeGeojson());
            }
            return batch

        } else if (this.key.geometryType === BatchingKey.GeometryType.BLOCK_INSTANCE) {
            const size = this.transforms.GetSize()
            const batch = {
                key: this.key,
                transformsSize: size
            }
            return batch

        } else {
            const size = this.vertices.GetSize()
            const batch = {
                key: this.key,
                verticesSize: size
            }
            batch.features=this.feature;
            return batch
        }
    }

    _NewChunk(initialCapacity) {
        const chunk = new IndexedChunk(initialCapacity)
        this.chunks.push(chunk)
        return chunk
    }
}