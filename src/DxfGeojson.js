
import { BatchingKey } from "./BatchingKey"
import { Matrix3, Vector2 } from "three"
import { TextRenderer } from "./geojson/TextRenderer"
import { RBTree } from "./RBTree"
import { MTextFormatParser } from "./MTextFormatParser";
import { RenderBatch } from "./geojson/RenderBatch.js";
import { Block } from "./geojson/Block.js";
import { BlockContext } from "./geojson/BlockContext.js";
import { Entity } from "./geojson/Entity.js";
import { PdMode, ColorCode, POINT_CIRCLE_TESSELLATION_ANGLE, POINT_SHAPE_BLOCK_NAME, SPLINE_SUBDIVISION, SPECIAL_CHARS_RE } from "./Constant";




/** This class prepares an internal representation of a DXF file, optimized fo WebGL rendering. It
 * is decoupled in such a way so that it should be possible to build it in a web-worker, effectively
 * transfer it to the main thread, and easily apply it to a Three.js scene there.
 */
export class DxfGeojson {

    constructor(options) {
        this.options = Object.create(DxfGeojson.DefaultOptions)
        if (options) {
            Object.assign(this.options, options.sceneOptions)
        }

        /* Scene origin. All input coordinates are made local to this point to minimize precision
        * loss.
        */
        this.origin = null
        /* RBTree<BatchingKey, RenderBatch> */
        this.batches = new RBTree((b1, b2) => b1.key.Compare(b2.key))
        /* Indexed by layer name, value is layer object from parsed DXF. */
        this.layers = new Map()
        /* Indexed by block name, value is Block. */
        this.blocks = new Map()
        this.bounds = null
        this.pointShapeBlock = null
        this.numBlocksFlattened = 0
    }

    /** Build the scene from the provided parsed DXF.
     * @param dxf {{}} Parsed DXF file.
     * @param fontFetchers {?Function[]} List of font fetchers. Fetcher should return promise with
     *  loaded font object (opentype.js). They are invoked only when necessary. Each glyph is being
     *  searched sequentially in each provided font.
     */
    async Build(dxf, fontFetchers) {
        const header = dxf.header || {}
        /* 0 - CCW, 1 - CW */
        this.angBase = header["$ANGBASE"] || 0
        /* Zero angle direction, 0 is +X */
        this.angDir = header["$ANGDIR"] || 0
        this.pdMode = header["$PDMODE"] || 0
        this.pdSize = header["$PDSIZE"] || 0

        if (dxf.tables && dxf.tables.layer) {
            for (const [, layer] of Object.entries(dxf.tables.layer.layers)) {
                this.layers.set(layer.name, layer)
            }

        }
        debugger
        if (dxf.blocks) {
            for (const [, block] of Object.entries(dxf.blocks)) {
                this.blocks.set(block.name, new Block(block))
            }
        }

        this.textRenderer = new TextRenderer(fontFetchers, this.options.textOptions)
        this.hasMissingChars = false
        await this._FetchFonts(dxf)

        /* Scan all entities to analyze block usage statistics. */
        for (const entity of dxf.entities) {
            if (entity.type === "INSERT") {
                //判断block引用的entity数量
                const block = this.blocks.get(entity.name)
                block?.RegisterInsert(entity)
            }
        }

        //遍历block
        for (const block of this.blocks.values()) {
            if (block.data.hasOwnProperty("entities")) {
                //创建block定义
                const blockCtx = block.DefinitionContext()
                //遍历block下的entity实体，并指向父节点
                for (const entity of block.data.entities) {
                    this._ProcessDxfEntity(entity, blockCtx)
                }
            }
            if (block.SetFlatten()) {
                this.numBlocksFlattened++
            }
        }
        console.log(`${this.numBlocksFlattened} blocks flattened`)

        //遍历所有实体
        for (const entity of dxf.entities) {
            this._ProcessDxfEntity(entity)
        }

        this.scene = this._BuildScene()

        delete this.batches
        delete this.layers
        delete this.blocks
        delete this.textRenderer
    }


    async _FetchFonts(dxf) {

        const ProcessEntity = async (entity) => {
            let ret
            if (entity.type === "TEXT") {
                ret = await this.textRenderer.FetchFonts(this._ParseSpecialChars(entity.text))
            } else if (entity.type === "MTEXT") {
                const parser = new MTextFormatParser()
                parser.Parse(entity.text)
                //XXX formatted MTEXT may specify some fonts explicitly, this is not yet supported
                for (const text of parser.GetText()) {
                    if (!await this.textRenderer.FetchFonts(this._ParseSpecialChars(text))) {
                        ret = false
                        break
                    }
                }
                ret = true
            } else {
                throw new Error("Bad entity type")
            }
            if (!ret) {
                this.hasMissingChars = true
            }
            return ret
        }

        for (const entity of dxf.entities) {
            if (entity.type === "TEXT" || entity.type === "MTEXT") {
                if (!await ProcessEntity(entity)) {
                    /* Failing to resolve some character means that all fonts have been loaded and
                     * checked. No mean to check the rest strings. However until it is encountered,
                     * all strings should be checked, even if all fonts already loaded. This needed
                     * to properly set hasMissingChars which allows displaying some warning in a
                     * viewer.
                     */
                    return
                }
            }
        }
        for (const block of this.blocks.values()) {
            if (block.data.hasOwnProperty("entities")) {
                for (const entity of block.data.entities) {
                    if (entity.type === "TEXT" || entity.type === "MTEXT") {
                        if (!await ProcessEntity(entity)) {
                            return
                        }
                    }
                }
            }
        }
    }
    /**
     * 循环遍历entity
     * @param {*} entity 
     * @param {*} blockCtx 父节点block
     * @returns 
     */
    _ProcessDxfEntity(entity, blockCtx = null) {
        let renderEntities
        switch (entity.type) {
            // case "LINE":
            //     renderEntities = this._DecomposeLine(entity, blockCtx)
            //     break
            case "POLYLINE":
            case "LWPOLYLINE":
                renderEntities = this._DecomposePolyline(entity, blockCtx)
                break
            // case "ARC":
            //     renderEntities = this._DecomposeArc(entity, blockCtx)
            //     break
            // case "CIRCLE":
            //     renderEntities = this._DecomposeCircle(entity, blockCtx)
            //     break
            // case "ELLIPSE":
            //     renderEntities = this._DecomposeEllipse(entity, blockCtx)
            //     break
            // case "POINT":
            //     renderEntities = this._DecomposePoint(entity, blockCtx)
            //     break
            // case "SPLINE":
            //     renderEntities = this._DecomposeSpline(entity, blockCtx)
            //     break
            // case "INSERT":
            //     /* Works with rendering batches without intermediate entities. */
            //     this._ProcessInsert(entity, blockCtx)
            //     return
            // case "TEXT":
            //     renderEntities = this._DecomposeText(entity, blockCtx)
            //     break
            // case "MTEXT":
            //     renderEntities = this._DecomposeMText(entity, blockCtx)
            //     break
            // case "3DFACE":
            //     renderEntities = this._Decompose3DFace(entity, blockCtx)
            //     break
            // case "SOLID":
            //     renderEntities = this._DecomposeSolid(entity, blockCtx)
            //     break
            default:
                console.log("Unhandled entity type: " + entity.type)
                return
        }
        //处理自定义Entity
        for (const renderEntity of renderEntities) {
            this._ProcessEntity(renderEntity, blockCtx)
        }
    }

    /**
     * @param entity {Entity} 自定义Entity
     * @param blockCtx {?BlockContext}
     */
    _ProcessEntity(entity, blockCtx = null) {
        switch (entity.type) {
            case Entity.Type.POINTS:
                this._ProcessPoints(entity, blockCtx)
                break
            case Entity.Type.LINE_SEGMENTS:
                this._ProcessLineSegments(entity, blockCtx)
                break
            case Entity.Type.POLYLINE:
                this._ProcessPolyline(entity, blockCtx)
                break
            case Entity.Type.TRIANGLES:
                this._ProcessTriangles(entity, blockCtx)
                break
            default:
                throw new Error("Unhandled entity type: " + entity.type)
        }
    }

    /**
     * @param entity
     * @param vertex
     * @param blockCtx {?BlockContext}
     * @return {number}
     */
    _GetLineType(entity, vertex = null, blockCtx = null) {
        //XXX lookup
        return 0
    }

    /** Check if start/end with are not specified. */
    _IsPlainLine(entity) {
        return !Boolean(entity.startWidth || entity.endWidth)
    }

    *_DecomposeLine(entity, blockCtx) {
        /* start/end width, bulge - seems cannot be present, at least with current parser */
        if (entity.vertices.length !== 2) {
            return
        }
        const layer = this._GetEntityLayer(entity, blockCtx)
        const color = this._GetEntityColor(entity, blockCtx)
        yield new Entity({
            type: Entity.Type.LINE_SEGMENTS,
            vertices: entity.vertices,
            layer, color,
            lineType: this._GetLineType(entity, entity.vertices[0])
        })
    }

    /** Generate vertices for bulged line segment.
     *
     * @param vertices Generated vertices pushed here.
     * @param startVtx Starting vertex. Assuming it is already present in the vertices array.
     * @param endVtx Ending vertex.
     * @param bulge Bulge value (see DXF specification).
     */
    _GenerateBulgeVertices(vertices, startVtx, endVtx, bulge) {
        const a = 4 * Math.atan(bulge)
        const aAbs = Math.abs(a)
        if (aAbs < this.options.arcTessellationAngle) {
            vertices.push(endVtx)
            return
        }
        const ha = a / 2
        const sha = Math.sin(ha)
        const cha = Math.cos(ha)
        const d = { x: endVtx.x - startVtx.x, y: endVtx.y - startVtx.y }
        const dSq = d.x * d.x + d.y * d.y
        if (dSq < Number.MIN_VALUE * 2) {
            /* No vertex is pushed since end vertex is duplicate of start vertex. */
            return
        }
        const D = Math.sqrt(dSq)
        let R = D / 2 / sha
        d.x /= D
        d.y /= D
        const center = {
            x: (d.x * sha - d.y * cha) * R + startVtx.x,
            y: (d.x * cha + d.y * sha) * R + startVtx.y
        }

        let numSegments = Math.floor(aAbs / this.options.arcTessellationAngle)
        if (numSegments < this.options.minArcTessellationSubdivisions) {
            numSegments = this.options.minArcTessellationSubdivisions
        }
        if (numSegments > 1) {
            const startAngle = Math.atan2(startVtx.y - center.y, startVtx.x - center.x)
            const step = a / numSegments
            if (a < 0) {
                R = -R
            }
            for (let i = 1; i < numSegments; i++) {
                const a = startAngle + i * step
                const v = {
                    x: center.x + R * Math.cos(a),
                    y: center.y + R * Math.sin(a)
                }
                vertices.push(v)
            }
        }
        vertices.push(endVtx)
    }

    /** Generate vertices for arc segment.
     *
     * @param vertices Generated vertices pushed here.
     * @param center {{x, y}} Center vector.
     * @param radius {number}
     * @param startAngle {?number} Start angle. Zero if not specified. Arc is drawn in CCW direction
     *  from start angle towards end angle.
     * @param endAngle {?number} Optional end angle. Full circle is drawn if not specified.
     * @param tessellationAngle {?number} Arc tessellation angle, default value is taken from scene
     *  options.
     * @param yRadius {?number} Specify to get ellipse arc. `radius` parameter used as X radius.
     * @param transform {?Matrix3} Optional transform matrix for the arc. Applied as last operation.
     */
    _GenerateArcVertices({ vertices, center, radius, startAngle = null, endAngle = null,
        tessellationAngle = null, yRadius = null, transform = null }) {
        if (!center || !radius) {
            return
        }
        if (!tessellationAngle) {
            tessellationAngle = this.options.arcTessellationAngle
        }
        if (yRadius === null) {
            yRadius = radius
        }
        /* Normalize angles - make them starting from +X in CCW direction. End angle should be
         * greater than start angle.
         */
        if (startAngle === undefined || startAngle === null) {
            startAngle = 0
        } else {
            startAngle += this.angBase
        }
        let isClosed = false
        if (endAngle === undefined || endAngle === null) {
            endAngle = startAngle + 2 * Math.PI
            isClosed = true
        } else {
            endAngle += this.angBase
        }
        if (this.angDir) {
            const tmp = startAngle
            startAngle = endAngle
            endAngle = tmp
        }
        while (endAngle <= startAngle) {
            endAngle += Math.PI * 2
        }

        const arcAngle = endAngle - startAngle
        let numSegments = Math.floor(arcAngle / tessellationAngle)
        if (numSegments === 0) {
            numSegments = 1
        }
        const step = arcAngle / numSegments
        for (let i = 0; i <= numSegments; i++) {
            if (i === numSegments && isClosed) {
                break
            }
            const a = startAngle + i * step
            const v = new Vector2(radius * Math.cos(a), yRadius * Math.sin(a))
            v.add(center)
            if (transform) {
                v.applyMatrix3(transform)
            }
            vertices.push(v)
        }
    }

    *_DecomposeArc(entity, blockCtx) {
        const color = this._GetEntityColor(entity, blockCtx)
        const layer = this._GetEntityLayer(entity, blockCtx)
        const lineType = this._GetLineType(entity, null, blockCtx)
        const vertices = []
        this._GenerateArcVertices({
            vertices, center: entity.center, radius: entity.radius,
            startAngle: entity.startAngle, endAngle: entity.endAngle,
            transform: this._GetEntityExtrusionTransform(entity)
        })
        yield new Entity({
            type: Entity.Type.POLYLINE,
            vertices, layer, color, lineType,
            shape: entity.endAngle === undefined
        })
    }

    *_DecomposeCircle(entity, blockCtx) {
        const color = this._GetEntityColor(entity, blockCtx)
        const layer = this._GetEntityLayer(entity, blockCtx)
        const lineType = this._GetLineType(entity, null, blockCtx)
        const vertices = []
        this._GenerateArcVertices({
            vertices, center: entity.center, radius: entity.radius,
            transform: this._GetEntityExtrusionTransform(entity)
        })
        yield new Entity({
            type: Entity.Type.POLYLINE,
            vertices, layer, color, lineType,
            shape: true
        })
    }

    *_DecomposeEllipse(entity, blockCtx) {
        const color = this._GetEntityColor(entity, blockCtx)
        const layer = this._GetEntityLayer(entity, blockCtx)
        const lineType = this._GetLineType(entity, null, blockCtx)
        const vertices = []
        const xR = Math.sqrt(entity.majorAxisEndPoint.x * entity.majorAxisEndPoint.x +
            entity.majorAxisEndPoint.y * entity.majorAxisEndPoint.y)
        const yR = xR * entity.axisRatio
        const rotation = Math.atan2(entity.majorAxisEndPoint.y, entity.majorAxisEndPoint.x)
        this._GenerateArcVertices({
            vertices, center: entity.center, radius: xR,
            startAngle: entity.startAngle, endAngle: entity.endAngle,
            yRadius: yR,
            transform: this._GetEntityExtrusionTransform(entity)
        })
        if (rotation !== 0) {
            //XXX should account angDir?
            const cos = Math.cos(rotation)
            const sin = Math.sin(rotation)
            for (const v of vertices) {
                const tx = v.x - entity.center.x
                const ty = v.y - entity.center.y
                /* Rotate the vertex around the ellipse center point. */
                v.x = tx * cos - ty * sin + entity.center.x
                v.y = tx * sin + ty * cos + entity.center.y
            }
        }
        yield new Entity({
            type: Entity.Type.POLYLINE,
            vertices, layer, color, lineType,
            shape: entity.endAngle === undefined
        })
    }

    *_DecomposePoint(entity, blockCtx) {
        if (this.pdMode === PdMode.NONE) {
            /* Points not displayed. */
            return
        }
        if (this.pdMode !== PdMode.DOT && this.pdSize <= 0) {
            /* Currently not supported. */
            return
        }
        const color = this._GetEntityColor(entity, blockCtx)
        const layer = this._GetEntityLayer(entity, blockCtx)
        const markType = this.pdMode & PdMode.MARK_MASK
        const isShaped = (this.pdMode & PdMode.SHAPE_MASK) !== 0

        if (isShaped) {
            /* Shaped mark should be instanced. */
            const key = new BatchingKey(layer, POINT_SHAPE_BLOCK_NAME,
                BatchingKey.GeometryType.POINT_INSTANCE, color, 0)
            const batch = this._GetBatch(key)
            batch.PushVertex(this._TransformVertex(entity.position))
            this._CreatePointShapeBlock()
            return
        }

        if (markType === PdMode.DOT) {
            yield new Entity({
                type: Entity.Type.POINTS,
                vertices: [entity.position],
                layer, color,
                lineType: null
            })
            return
        }

        const vertices = []
        this._CreatePointMarker(vertices, markType, entity.position)
        yield new Entity({
            type: Entity.Type.LINE_SEGMENTS,
            vertices, layer, color,
            lineType: null
        })
    }

    /** Create line segments for point marker.
     * @param vertices
     * @param markType
     * @param position {?{x,y}} point center position, default is zero.
     */
    _CreatePointMarker(vertices, markType, position = null) {
        const _this = this
        function PushVertex(offsetX, offsetY) {
            vertices.push({
                x: (position?.x ?? 0) + offsetX * _this.pdSize * 0.5,
                y: (position?.y ?? 0) + offsetY * _this.pdSize * 0.5
            })
        }

        switch (markType) {
            case PdMode.PLUS:
                PushVertex(0, 1.5)
                PushVertex(0, -1.5)
                PushVertex(-1.5, 0)
                PushVertex(1.5, 0)
                break
            case PdMode.CROSS:
                PushVertex(-1, 1)
                PushVertex(1, -1)
                PushVertex(1, 1)
                PushVertex(-1, -1)
                break
            case PdMode.TICK:
                PushVertex(0, 1)
                PushVertex(0, 0)
                break
            default:
                console.warn("Unsupported point display type: " + markType)
        }
    }

    /** Create point shape block if not yet done. */
    _CreatePointShapeBlock() {
        if (this.pointShapeBlock) {
            return
        }
        /* This mimics DXF block entity. */
        this.pointShapeBlock = new Block({
            name: POINT_SHAPE_BLOCK_NAME,
            position: { x: 0, y: 0 }
        })
        /* Fix block origin at zero. */
        this.pointShapeBlock.offset = new Vector2(0, 0)
        const blockCtx = this.pointShapeBlock.DefinitionContext()

        const markType = this.pdMode & PdMode.MARK_MASK
        if (markType !== PdMode.DOT && markType !== PdMode.NONE) {
            const vertices = []
            this._CreatePointMarker(vertices, markType)
            const entity = new Entity({
                type: Entity.Type.LINE_SEGMENTS,
                vertices,
                color: ColorCode.BY_BLOCK
            })
            this._ProcessEntity(entity, blockCtx)
        }

        if (this.pdMode & PdMode.SQUARE) {
            const r = this.pdSize * 0.5
            const vertices = [
                { x: -r, y: r },
                { x: r, y: r },
                { x: r, y: -r },
                { x: -r, y: -r }
            ]
            const entity = new Entity({
                type: Entity.Type.POLYLINE, vertices,
                color: ColorCode.BY_BLOCK,
                shape: true
            })
            this._ProcessEntity(entity, blockCtx)
        }
        if (this.pdMode & PdMode.CIRCLE) {
            const vertices = []
            this._GenerateArcVertices({
                vertices, center: { x: 0, y: 0 },
                radius: this.pdSize * 0.5,
                tessellationAngle: POINT_CIRCLE_TESSELLATION_ANGLE
            })
            const entity = new Entity({
                type: Entity.Type.POLYLINE, vertices,
                color: ColorCode.BY_BLOCK,
                shape: true
            })
            this._ProcessEntity(entity, blockCtx)
        }
    }

    *_Decompose3DFace(entity, blockCtx) {
        yield* this._DecomposeFace(entity, entity.vertices, blockCtx, this.options.wireframeMesh)
    }

    *_DecomposeSolid(entity, blockCtx) {
        yield* this._DecomposeFace(entity, entity.points, blockCtx, false,
            this._GetEntityExtrusionTransform(entity))
    }

    *_DecomposeFace(entity, vertices, blockCtx, wireframe, transform = null) {
        const layer = this._GetEntityLayer(entity, blockCtx)
        const color = this._GetEntityColor(entity, blockCtx)

        function IsValidTriangle(v1, v2, v3) {
            const e1 = new Vector2().subVectors(v2, v1)
            const e2 = new Vector2().subVectors(v3, v1)
            const area = Math.abs(e1.cross(e2))
            return area > Number.EPSILON
        }

        const v0 = new Vector2(vertices[0].x, vertices[0].y)
        const v1 = new Vector2(vertices[1].x, vertices[1].y)
        const v2 = new Vector2(vertices[2].x, vertices[2].y)
        let v3 = null

        let hasFirstTriangle = IsValidTriangle(v0, v1, v2)
        let hasSecondTriangle = false

        if (vertices.length > 3) {
            /* Fourth vertex may be the same as one of the previous vertices, so additional triangle
             * for degeneration.
             */

            v3 = new Vector2(vertices[3].x, vertices[3].y)
            hasSecondTriangle = IsValidTriangle(v1, v3, v2)
            if (transform) {
                v3.applyMatrix3(transform)
            }
        }
        if (transform) {
            v0.applyMatrix3(transform)
            v1.applyMatrix3(transform)
            v2.applyMatrix3(transform)
        }

        if (!hasFirstTriangle && !hasSecondTriangle) {
            return
        }

        if (wireframe) {
            const _vertices = []
            if (hasFirstTriangle && !hasSecondTriangle) {
                _vertices.push(v0, v1, v2)
            } if (!hasFirstTriangle && hasSecondTriangle) {
                _vertices.push(v1, v3, v2)
            } else {
                _vertices.push(v0, v1, v3, v2)
            }
            yield new Entity({
                type: Entity.Type.POLYLINE,
                vertices: _vertices, layer, color,
                shape: true
            })

        } else {
            const _vertices = []
            const indices = []
            if (hasFirstTriangle) {
                _vertices.push(v0, v1, v2)
                indices.push(0, 1, 2)
            }
            if (hasSecondTriangle) {
                if (!hasFirstTriangle) {
                    _vertices.push(v1, v2)
                    indices.push(0, 1, 2)
                } else {
                    indices.push(1, 2, 3)
                }
                _vertices.push(v3)
            }
            yield new Entity({
                type: Entity.Type.TRIANGLES,
                vertices: _vertices, indices, layer, color
            })
        }
    }

    *_DecomposeText(entity, blockCtx) {
        if (!this.textRenderer.canRender) {
            return
        }
        const layer = this._GetEntityLayer(entity, blockCtx)
        const color = this._GetEntityColor(entity, blockCtx)
        yield* this.textRenderer.Render({
            text: this._ParseSpecialChars(entity.text),
            fontSize: entity.textHeight,
            startPos: entity.startPoint,
            endPos: entity.endPoint,
            rotation: entity.rotation,
            hAlign: entity.halign,
            vAlign: entity.valign,
            widthFactor: entity.xScale,
            color, layer
        })
    }

    *_DecomposeMText(entity, blockCtx) {
        if (!this.textRenderer.canRender) {
            return
        }
        const layer = this._GetEntityLayer(entity, blockCtx)
        const color = this._GetEntityColor(entity, blockCtx)
        const parser = new MTextFormatParser()
        parser.Parse(this._ParseSpecialChars(entity.text))
        yield* this.textRenderer.RenderMText({
            formattedText: parser.GetContent(),
            fontSize: entity.height,
            position: entity.position,
            rotation: entity.rotation,
            direction: entity.direction,
            attachment: entity.attachmentPoint,
            lineSpacing: entity.lineSpacing,
            width: entity.width,
            color, layer
        })
    }

    /**
     * Updates batches directly.
     * @param entity
     * @param blockCtx {?BlockContext} Nested block insert when non-null.
     */
    _ProcessInsert(entity, blockCtx = null) {
        if (blockCtx) {
            //XXX handle indirect recursion
            if (blockCtx.name === entity.name) {
                console.warn("Recursive block reference: " + blockCtx.name)
                return
            }
            /* Flatten nested blocks definition. */
            const block = this.blocks.get(entity.name)
            if (!block) {
                console.warn("Unresolved nested block reference: " + entity.name)
            }
            const nestedCtx = blockCtx.NestedBlockContext(block, entity)
            if (block.data.entities) {
                for (const entity of block.data.entities) {
                    this._ProcessDxfEntity(entity, nestedCtx)
                }
            }
            return
        }

        const block = this.blocks.get(entity.name)
        if (block === null) {
            console.warn("Unresolved block reference in INSERT: " + entity.name)
            return
        }
        if (!block.HasGeometry()) {
            return
        }

        const layer = this._GetEntityLayer(entity, null)
        const color = this._GetEntityColor(entity, null)
        const lineType = this._GetLineType(entity, null, null)
        //XXX apply extrusion direction
        const transform = block.InstantiationContext().GetInsertionTransform(entity)

        /* Update bounding box and origin with transformed block bounds corner points. */
        const bounds = block.bounds
        this._UpdateBounds(new Vector2(bounds.minX, bounds.minY).applyMatrix3(transform))
        this._UpdateBounds(new Vector2(bounds.maxX, bounds.maxY).applyMatrix3(transform))
        this._UpdateBounds(new Vector2(bounds.minX, bounds.maxY).applyMatrix3(transform))
        this._UpdateBounds(new Vector2(bounds.maxX, bounds.minY).applyMatrix3(transform))

        transform.translate(-this.origin.x, -this.origin.y)
        //XXX grid instancing not supported yet
        if (block.flatten) {
            for (const batch of block.batches) {
                this._FlattenBatch(batch, layer, color, lineType, transform)
            }
        } else {
            const key = new BatchingKey(layer, entity.name, BatchingKey.GeometryType.BLOCK_INSTANCE,
                color, lineType)
            const batch = this._GetBatch(key)
            batch.PushInstanceTransform(transform)
        }
    }

    /** Flatten block definition batch. It is merged into suitable instant rendering batch. */
    _FlattenBatch(blockBatch, layerName, blockColor, blockLineType, transform) {
        const layer = this.layers.get(layerName)
        let color, lineType = 0
        if (blockBatch.key.color === ColorCode.BY_BLOCK) {
            color = blockColor
        } else if (blockBatch.key.color === ColorCode.BY_LAYER) {
            color = layer?.color ?? 0
        } else {
            color = blockBatch.key.color
        }
        //XXX line type
        const key = new BatchingKey(layerName, null, blockBatch.key.geometryType, color, lineType)
        const batch = this._GetBatch(key)
        batch.Merge(blockBatch, transform)
    }

    /**
     * Generate entities for shaped polyline (e.g. line resulting in mesh). All segments are shaped
     * (have start/end width). Segments may be bulge.
     * @param vertices
     * @param layer
     * @param color
     * @param lineType
     * @param shape {Boolean} True if closed polyline.
     * @return {Generator<Entity>}
     */
    *_GenerateShapedPolyline(vertices, layer, color, lineType, shape) {
        //XXX
        yield new Entity({
            type: Entity.Type.POLYLINE,
            vertices,
            layer,
            color,
            lineType,
            shape
        })
    }

    /** Mirror entity vertices if necessary in case of extrusionDirection with negative Z specified.
     *
     * @param entity Entity to check.
     * @param vertices {?{x,y}[]} Vertices array to use instead of entity vertices attribute.
     * @return {{x,y}[]} Vertices array with mirrored X if necessary. All attributes preserved.
     */
    _MirrorEntityVertices(entity, vertices = null) {
        if (!entity.extrusionDirection || entity.extrusionDirection.z >= 0) {
            return vertices ?? entity.vertices
        }
        if (!vertices || vertices === entity.vertices) {
            vertices = entity.vertices.slice()
        }
        const n = vertices.length
        for (let i = 0; i < n; i++) {
            const v = vertices[i]
            const _v = { x: -v.x }
            for (const propName in v) {
                if (!v.hasOwnProperty(propName)) {
                    continue
                }
                if (propName !== "x") {
                    _v[propName] = v[propName]
                }
            }
            vertices[i] = _v
        }
        return vertices
    }

    *_DecomposePolyline(entity, blockCtx = null) {
        let entityVertices, verticesCount
        if (entity.includesCurveFitVertices || entity.includesSplineFitVertices) {
            entityVertices = entity.vertices.filter(v => v.splineVertex || v.curveFittingVertex)
            verticesCount = entityVertices.length
        } else {
            entityVertices = entity.vertices
            verticesCount = entity.vertices.length
        }
        if (verticesCount < 2) {
            return
        }
        //拉伸方向（Z）为负的情况下镜像顶点坐标
        entityVertices = this._MirrorEntityVertices(entity, entityVertices)
        //如果有blockCtx，返回entity或默认的颜色；如果没有blockCtx，则返回所属图层颜色或entity颜色
        const color = this._GetEntityColor(entity, blockCtx);
        //如果有blockCtx，layer返回空；如果没有blockCtx，则返回所属图层名称
        const layer = this._GetEntityLayer(entity, blockCtx)
        const _this = this
        let startIdx = 0
        let curPlainLine = this._IsPlainLine(entityVertices[0])
        //暂时默认为0，后续扩展
        let curLineType = this._GetLineType(entity, entityVertices[0], blockCtx)
        let curVertices = null

        function* CommitSegment(endIdx) {
            if (endIdx === startIdx) {
                return
            }
            let isClosed = false
            let vertices = curVertices
            if (endIdx === verticesCount && startIdx === 0) {
                isClosed = true
                if (vertices === null) {
                    vertices = entityVertices
                }
            } else if (endIdx === verticesCount - 1 && startIdx === 0) {
                if (vertices === null) {
                    vertices = entityVertices
                }
            } else if (endIdx === verticesCount) {
                if (vertices === null) {
                    vertices = entityVertices.slice(startIdx, endIdx)
                    vertices.push(entityVertices[0])
                }
            } else {
                if (vertices === null) {
                    vertices = entityVertices.slice(startIdx, endIdx + 1)
                }
            }

            if (curPlainLine) {
                yield new Entity({
                    type: Entity.Type.POLYLINE,
                    vertices, layer, color,
                    lineType: curLineType,
                    shape: isClosed
                })
            } else {
                yield* _this._GenerateShapedPolyline(vertices, layer, color, curLineType, isClosed)
            }

            startIdx = endIdx
            if (endIdx !== verticesCount) {
                curPlainLine = _this._IsPlainLine(entityVertices[endIdx])
                curLineType = _this._GetLineType(entity, entityVertices[endIdx])
            }
            curVertices = null
        }

        for (let vIdx = 1; vIdx <= verticesCount; vIdx++) {
            const prevVtx = entityVertices[vIdx - 1]
            let vtx
            if (vIdx === verticesCount) {
                if (!entity.shape) {
                    yield* CommitSegment(vIdx - 1)
                    break
                }
                vtx = entityVertices[0]
            } else {
                vtx = entityVertices[vIdx]
            }

            if (Boolean(prevVtx.bulge) && curPlainLine) {
                if (curVertices === null) {
                    curVertices = entityVertices.slice(startIdx, vIdx)
                }
                this._GenerateBulgeVertices(curVertices, prevVtx, vtx, prevVtx.bulge)
            } else if (curVertices !== null) {
                curVertices.push(vtx)
            }

            if (vIdx === verticesCount) {
                yield* CommitSegment(vIdx)
                break
            }

            const isPlainLine = this._IsPlainLine(vtx)
            const lineType = this._GetLineType(entity, vtx)
            if (isPlainLine !== curPlainLine ||
                /* Line type is accounted for plain lines only. */
                (curPlainLine && lineType !== curLineType)) {

                yield* CommitSegment(vIdx)
            }
        }
    }

    *_DecomposeSpline(entity, blockCtx = null) {
        const color = this._GetEntityColor(entity, blockCtx)
        const layer = this._GetEntityLayer(entity, blockCtx)
        const lineType = this._GetLineType(entity, null, blockCtx)
        const controlPoints = entity.controlPoints.map(p => [p.x, p.y])
        const vertices = []
        const subdivisions = controlPoints.length * SPLINE_SUBDIVISION
        const step = 1 / subdivisions
        for (let i = 0; i <= subdivisions; i++) {
            const pt = this._InterpolateSpline(i * step, entity.degreeOfSplineCurve, controlPoints,
                entity.knotValues)
            vertices.push({ x: pt[0], y: pt[1] })
        }
        //XXX extrusionDirection (normalVector) transform?
        yield new Entity({ type: Entity.Type.POLYLINE, vertices, layer, color, lineType })
    }

    /** Get a point on a B-spline.
     * https://github.com/thibauts/b-spline
     * @param t {number} Point position on spline, [0..1].
     * @param degree {number} B-spline degree.
     * @param points {number[][]} Control points. Each point should have the same dimension which
     *  defines dimension of the result.
     * @param knots {?number[]} Knot vector. Should have size `points.length + degree + 1`. Default
     *  is uniform spline.
     * @param weights {?number} Optional weights vector.
     * @return {number[]} Resulting point on the specified position.
     */
    _InterpolateSpline(t, degree, points, knots = null, weights = null) {
        let i, j, s, l             // function-scoped iteration variables
        const n = points.length    // points count
        const d = points[0].length // point dimensionality

        if (degree < 1) {
            throw new Error("Degree must be at least 1 (linear)")
        }
        if (degree > (n - 1)) {
            throw new Error("Degree must be less than or equal to point count - 1")
        }

        if (!weights) {
            // build weight vector of length [n]
            weights = []
            for (i = 0; i < n; i++) {
                weights[i] = 1
            }
        }

        if (!knots) {
            // build knot vector of length [n + degree + 1]
            knots = []
            for (i = 0; i < n + degree + 1; i++) {
                knots[i] = i
            }
        } else {
            if (knots.length !== n + degree + 1) {
                throw new Error("Bad knot vector length")
            }
        }

        const domain = [
            degree,
            knots.length - 1 - degree
        ]

        // remap t to the domain where the spline is defined
        const low = knots[domain[0]]
        const high = knots[domain[1]]
        t = t * (high - low) + low

        if (t < low) {
            t = low
        } else if (t > high) {
            t = high
        }

        // find s (the spline segment) for the [t] value provided
        for (s = domain[0]; s < domain[1]; s++) {
            if (t >= knots[s] && t <= knots[s + 1]) {
                break
            }
        }

        // convert points to homogeneous coordinates
        const v = []
        for (i = 0; i < n; i++) {
            v[i] = []
            for (j = 0; j < d; j++) {
                v[i][j] = points[i][j] * weights[i]
            }
            v[i][d] = weights[i]
        }

        // l (level) goes from 1 to the curve degree + 1
        let alpha
        for (l = 1; l <= degree + 1; l++) {
            // build level l of the pyramid
            for (i = s; i > s - degree - 1 + l; i--) {
                alpha = (t - knots[i]) / (knots[i + degree + 1 - l] - knots[i])
                // interpolate each component
                for (j = 0; j < d + 1; j++) {
                    v[i][j] = (1 - alpha) * v[i - 1][j] + alpha * v[i][j]
                }
            }
        }

        // convert back to cartesian and return
        const result = []
        for (i = 0; i < d; i++) {
            result[i] = v[s][i] / v[s][d]
        }
        return result
    }

    /**
     * @param entity {Entity}
     * @param blockCtx {?BlockContext}
     */
    _ProcessPoints(entity, blockCtx = null) {
        const key = new BatchingKey(entity.layer, blockCtx?.name,
            BatchingKey.GeometryType.POINTS, entity.color, 0)
        const batch = this._GetBatch(key)
        for (const v of entity.vertices) {
            batch.PushVertex(this._TransformVertex(v, blockCtx))
        }
    }

    /**
     * @param entity {Entity}
     * @param blockCtx {?BlockContext}
     */
    _ProcessLineSegments(entity, blockCtx = null) {
        if (entity.vertices.length % 2 !== 0) {
            throw Error("Even number of vertices expected")
        }
        const key = new BatchingKey(entity.layer, blockCtx?.name,
            BatchingKey.GeometryType.LINES, entity.color, entity.lineType)
        const batch = this._GetBatch(key)
        for (const v of entity.vertices) {
            batch.PushVertex(this._TransformVertex(v, blockCtx))
        }
    }

    /**
     * @param entity {Entity}
     * @param blockCtx {?BlockContext}
     */
    _ProcessPolyline(entity, blockCtx = null) {
        if (entity.vertices.length < 2) {
            return
        }
        /* It is more optimal to render short polylines un-indexed. Also DXF often contains
         * polylines with just two points.
         */
        const verticesCount = entity.vertices.length
        if (verticesCount <= 3) {
            //根据图层名称、父节点名称、类型、实体颜色、线性生成key
            const key = new BatchingKey(entity.layer, blockCtx?.name,
                BatchingKey.GeometryType.LINES, entity.color,
                entity.lineType)
            const batch = this._GetBatch(key)
            let prev = null
            let latlngs = [];
            for (const v of entity.vertices) {
                if (prev !== null) {
                    batch.PushVertex(this._TransformVertex(prev, blockCtx))
                    batch.PushVertex(this._TransformVertex(v, blockCtx))
                    batch.PushLatlng(this._TransformVertex(prev, blockCtx));
                    batch.PushLatlng(this._TransformVertex(v, blockCtx))
                    latlngs.push(this._TransformVertexTolonlat(prev, blockCtx));
                    latlngs.push(this._TransformVertexTolonlat(v, blockCtx));
                }
                prev = v
            }
            if (entity.shape && verticesCount > 2) {
                batch.PushVertex(this._TransformVertex(entity.vertices[verticesCount - 1], blockCtx))
                batch.PushVertex(this._TransformVertex(entity.vertices[0], blockCtx)); debugger
                // latlngs.push([this._TransformVertex(entity.vertices[verticesCount - 1], blockCtx).x, this._TransformVertex(entity.vertices[0], blockCtx).y]);
                latlngs.push(this._TransformVertexTolonlat(entity.vertices[verticesCount - 1], blockCtx));
                latlngs.push(this._TransformVertexTolonlat(entity.vertices[0], blockCtx));
            }
            let f = {
                "type": "Feature",
                "geometry": {
                    "type": "LineString",
                    "coordinates": latlngs
                }
            };
            batch.PushFeature(f);

            return
        }

        const key = new BatchingKey(entity.layer, blockCtx?.name,
            BatchingKey.GeometryType.INDEXED_LINES,
            entity.color, entity.lineType)
        const batch = this._GetBatch(key)
        /* 拆分线 */
        
        for (const lineChunk of entity._IterateLineChunks()) {
            const chunk = batch.PushChunk(lineChunk.verticesCount)
            let coors=[];
            for (const v of lineChunk.vertices) {
                chunk.PushVertex(this._TransformVertex(v, blockCtx))
                // coors.push([this._TransformVertex(v, blockCtx).x, this._TransformVertex(v, blockCtx).y]);
                coors.push(this._TransformVertexTolonlat(v, blockCtx));
            }
            for (const idx of lineChunk.indices) {
                chunk.PushIndex(idx)
            }
            chunk.Finish();
            let f = {
                "type": "Feature",
                "geometry": {
                    "type": "LineString",
                    "coordinates": coors
                }
            };
            chunk.PushFeature(f);
        }
    }

    /**
     * @param entity {Entity}
     * @param blockCtx {?BlockContext}
     */
    _ProcessTriangles(entity, blockCtx = null) {
        if (entity.vertices.length < 3) {
            return
        }
        if (entity.indices.length % 3 !== 0) {
            console.error("Unexpected size of indices array: " + entity.indices.length)
            return
        }
        const key = new BatchingKey(entity.layer, blockCtx?.name,
            BatchingKey.GeometryType.INDEXED_TRIANGLES,
            entity.color, 0)
        const batch = this._GetBatch(key)
        //XXX splitting into chunks is not yet implemented. Currently used only for text glyphs so
        // should fit into one chunk
        const chunk = batch.PushChunk(entity.vertices.length)
        for (const v of entity.vertices) {
            chunk.PushVertex(this._TransformVertex(v, blockCtx))
        }
        for (const idx of entity.indices) {
            chunk.PushIndex(idx)
        }
        chunk.Finish()
    }

    /** Resolve entity color.
     *
     * @param entity
     * @param blockCtx {?BlockContext}
     * @return {number} RGB color value. For block entity it also may be one of ColorCode values
     *  which are resolved on block instantiation.
     */
    _GetEntityColor(entity, blockCtx = null) {
        let color = ColorCode.BY_LAYER
        if (entity.colorIndex === 0) {
            color = ColorCode.BY_BLOCK
        } else if (entity.colorIndex === 256) {
            color = ColorCode.BY_LAYER
        } else if (entity.hasOwnProperty("color")) {
            color = entity.color
        }

        if (blockCtx) {
            return color
        }
        if (color === ColorCode.BY_LAYER || color === ColorCode.BY_BLOCK) {
            /* BY_BLOCK is not useful when not in block so replace it by layer as well. */
            if (entity.hasOwnProperty("layer")) {
                const layer = this.layers.get(entity.layer)
                if (layer) {
                    return layer.color
                }
            }
        } else {
            return color
        }
        /* Fallback to black. */
        return 0
    }

    /** @return {?string} Layer name, null for block entity. */
    _GetEntityLayer(entity, blockCtx = null) {
        if (blockCtx) {
            return null
        }
        if (entity.hasOwnProperty("layer")) {
            return entity.layer
        }
        return "0"
    }

    /** Check extrusionDirection property of the entity and return corresponding transform matrix.
     *
     * @return {?Matrix3} Null if not transform required.
     */
    _GetEntityExtrusionTransform(entity) {
        //XXX For now just mirror X axis if extrusion Z is negative. No full support for arbitrary
        // OCS yet.
        if (!entity.hasOwnProperty("extrusionDirection")) {
            return null
        }
        if (entity.extrusionDirection.z > 0) {
            return null
        }
        return new Matrix3().scale(-1, 1)
    }

    /**
     * Parse special characters in text entities and convert them to corresponding unicode
     * characters.
     * https://knowledge.autodesk.com/support/autocad/learn-explore/caas/CloudHelp/cloudhelp/2019/ENU/AutoCAD-Core/files/GUID-518E1A9D-398C-4A8A-AC32-2D85590CDBE1-htm.html
     * @param {string} text Raw string.
     * @return {string} String with special characters replaced.
     */
    _ParseSpecialChars(text) {
        return text.replaceAll(SPECIAL_CHARS_RE, (match, p1, p2) => {
            if (p1 !== undefined) {
                switch (p1) {
                    case "d":
                        return "\xb0"
                    case "p":
                        return "\xb1"
                    case "c":
                        return "\u2205"
                }
            } else if (p2 !== undefined) {
                const code = parseInt(p2, 16)
                if (isNaN(code)) {
                    return match
                }
                return String.fromCharCode(code)
            }
            return match
        })
    }

    /** @return {RenderBatch} */
    _GetBatch(key) {
        let batch = this.batches.find({ key })
        if (batch !== null) {
            return batch
        }
        batch = new RenderBatch(key)
        this.batches.insert(batch)
        if (key.blockName !== null && !key.IsInstanced()) {
            /* Block definition batch. */
            const block = this.blocks.get(key.blockName)
            if (block) {
                block.batches.push(batch)
            }
        }
        return batch
    }

    /**
     * Apply all necessary final transforms to a vertex before just before storing it in a rendering
     * batch.
     * @param v {{x: number, y: number}}
     * @param blockCtx {BlockContext}
     * @return {{x: number, y: number}}
     */
    _TransformVertex(v, blockCtx = null) {
        if (blockCtx) {
            /* Block definition in block coordinates. So it should not touch bounds and origin. */
            return blockCtx.TransformVertex(v)
        }
        this._UpdateBounds(v)
        return { x: v.x - this.origin.x, y: v.y - this.origin.y }
    }
    _TransformVertexTolonlat(v, blockCtx = null) {
        if (blockCtx) {
            /* Block definition in block coordinates. So it should not touch bounds and origin. */
            return this.mercatorTolonlat([blockCtx.TransformVertex(v).x,blockCtx.TransformVertex(v).y]);
        }
        this._UpdateBounds(v);
        let result={ x: v.x - this.origin.x, y: v.y - this.origin.y };
        return this.mercatorTolonlat([result.x,result.y]);
    }
    mercatorTolonlat(mercator) {
        var lonlat = [0, 0]
        var x = mercator[0] / 20037508.34 * 180
        var y = mercator[1] / 20037508.34 * 180
        y = 180 / Math.PI * (2 * Math.atan(Math.exp(y * Math.PI / 180)) - Math.PI / 2)
        lonlat[0] = x
        lonlat[1] = y
        return lonlat
    }

    /** @param v {{x,y}} Vertex to extend bounding box with and set origin. */
    _UpdateBounds(v) {
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
        if (this.origin === null) {
            this.origin = { x: v.x, y: v.y }
        }
    }

    _BuildScene() {
        let verticesSize = 0
        let indicesSize = 0
        let transformsSize = 0
        this.batches.each(b => {
            verticesSize += b.GetVerticesBufferSize()
            indicesSize += b.GetIndicesBufferSize()
            transformsSize += b.GetTransformsSize()
        })

        const scene = {
            vertices: new ArrayBuffer(verticesSize),
            indices: new ArrayBuffer(indicesSize),
            transforms: new ArrayBuffer(transformsSize),
            batches: [],
            layers: [],
            origin: this.origin,
            bounds: this.bounds,
            hasMissingChars: this.hasMissingChars
        }

        const buffers = {
            vertices: new Float32Array(scene.vertices),
            verticesOffset: 0,
            indices: new Uint16Array(scene.indices),
            indicesOffset: 0,
            transforms: new Float32Array(scene.transforms),
            transformsOffset: 0
        }
        let geojson = {
            "type": "FeatureCollection",
            "features": []
        }
        this.batches.each(b => {
            scene.batches.push(b.Serialize(buffers));
            let fs = b.SerializeGeojson().features;
            geojson.features = geojson.features.concat(fs ? fs : []);
        })

        for (const layer of this.layers.values()) {
            scene.layers.push({
                name: layer.name,
                color: layer.color
            })
        }

        scene.pointShapeHasDot = (this.pdMode & PdMode.MARK_MASK) === PdMode.DOT
        scene.mercatorTolonlat = function (mercator) {
            var lonlat = [0, 0]
            var x = mercator[0] / 20037508.34 * 180
            var y = mercator[1] / 20037508.34 * 180
            y = 180 / Math.PI * (2 * Math.atan(Math.exp(y * Math.PI / 180)) - Math.PI / 2)
            lonlat[0] = x
            lonlat[1] = y
            return lonlat
        }
        scene.geojson = geojson;
        return scene
    }
}
DxfGeojson.DefaultOptions = {
    /** Target angle for each segment of tessellated arc. */
    arcTessellationAngle: 10 / 180 * Math.PI,
    /** Divide arc to at least the specified number of segments. */
    minArcTessellationSubdivisions: 8,
    /** Render meshes (3DFACE group) as wireframe instead of solid. */
    wireframeMesh: false,
    /** Text rendering options. */
    textOptions: TextRenderer.DefaultOptions,
}
