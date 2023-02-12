import {INDEXED_CHUNK_SIZE} from "../Constant";
/** Internal entity representation. DXF features are decomposed into these simpler entities. Whole
* entity always shares single material.
*/
export class Entity {
   /** @param type {number} See Entity.Type
    * @param vertices {{x, y}[]}
    * @param indices {?number[]} Indices for indexed geometry.
    * @param layer {?string}
    * @param color {number}
    * @param lineType {?number}
    * @param shape {Boolean} true if closed shape.
    */
   constructor({type, vertices, indices = null, layer = null, color, lineType = 0, shape = false}) {
       this.type = type
       this.vertices = vertices
       this.indices = indices
       this.layer = layer
       this.color = color
       this.lineType = lineType
       this.shape = shape
   }

   *_IterateVertices(startIndex, count) {
       for (let idx = startIndex; idx < startIndex + count; idx++) {
           yield this.vertices[idx]
       }
   }

   /** Split line into chunks with at most INDEXED_CHUNK_SIZE vertices in each one. Each chunk is
    * an object with the following properties:
    *  * "verticesCount" - length of "vertices"
    *  * "vertices" - iterator for included vertices.
    *  * "indices" - iterator for indices.
    *  Closed shapes are handled properly.
    */
   *_IterateLineChunks() {
       const verticesCount = this.vertices.length
       if (verticesCount < 2) {
           return
       }
       const _this = this
       /* chunkOffset == verticesCount for shape closing vertex. */
       for (let chunkOffset = 0; chunkOffset <= verticesCount; chunkOffset += INDEXED_CHUNK_SIZE) {
           let count = verticesCount - chunkOffset
           let isLast
           if (count > INDEXED_CHUNK_SIZE) {
               count = INDEXED_CHUNK_SIZE
               isLast = false
           } else {
               isLast = true
           }
           if (isLast && this.shape && chunkOffset > 0 && count === INDEXED_CHUNK_SIZE) {
               /* Corner case - required shape closing vertex does not fit into the chunk. Will
               * require additional chunk.
               */
               isLast = false
           }
           if (chunkOffset === verticesCount && !this.shape) {
               /* Shape is not closed and it is last closing vertex iteration. */
               break
           }

           let vertices, indices, chunkVerticesCount
           if (count < 2) {
               /* Either last vertex or last shape-closing vertex, or both. */
               if (count === 1 && this.shape) {
                   /* Both. */
                   vertices = (function*() {
                       yield this.vertices[chunkOffset]
                       yield this.vertices[0]
                   })()
               } else if (count === 1) {
                   /* Just last vertex. Take previous one to make a line. */
                   vertices = (function*() {
                       yield this.vertices[chunkOffset - 1]
                       yield this.vertices[chunkOffset]
                   })()
               } else {
                   /* Just shape-closing vertex. Take last one to make a line. */
                   vertices = (function*() {
                       yield this.vertices[verticesCount - 1]
                       yield this.vertices[0]
                   })()
               }
               indices = _IterateLineIndices(2, false)
               chunkVerticesCount = 2
           } else if (isLast && this.shape && chunkOffset > 0 && count < INDEXED_CHUNK_SIZE) {
               /* Additional vertex to close the shape. */
               vertices = (function*() {
                   yield* _this._IterateVertices(chunkOffset, count)
                   yield this.vertices[0]
               })()
               indices = _IterateLineIndices(count + 1, false)
               chunkVerticesCount = count + 1
           } else {
               vertices = this._IterateVertices(chunkOffset, count)
               indices = _IterateLineIndices(count,
                                             isLast && chunkOffset === 0 && this.shape)
               chunkVerticesCount = count
           }
           yield {
               verticesCount: chunkVerticesCount,
               vertices,
               indices
           }
       }
   }
}

Entity.Type = Object.freeze({
   POINTS: 0,
   /** Each vertices pair defines a segment. */
   LINE_SEGMENTS: 1,
   POLYLINE: 2,
   TRIANGLES: 3
})
function* _IterateLineIndices(verticesCount, close) {
    for (let idx = 0; idx < verticesCount - 1; idx++) {
        yield idx
        yield idx + 1
    }
    if (close && verticesCount > 2) {
        yield verticesCount - 1
        yield 0
    }
}