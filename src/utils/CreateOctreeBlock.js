import * as BABYLON from "@babylonjs/core";

const MAX_DEPTH = 4;
const MIN_SIZE = 0;
// Update the tracking variables to match Fbxload.js structure
let nodesAtDepth = new Array(MAX_DEPTH + 1).fill(0);
let nodeNumbersByDepth = Array.from({ length: MAX_DEPTH + 1 }, () => []);
let nodesAtDepthWithBoxes = new Array(MAX_DEPTH + 1).fill(0);
let boxesAtDepth = Array.from({ length: MAX_DEPTH + 1 }, () => new Set());
let nodeContents = new Map();
let nodeDepths = new Map();
let nodeParents = new Map();
let nodeCounter = 1;

export const createOctreeBlock = (scene, minimum, maximum, meshInfos, depth = 0, parent = null) => {
  console.log(`Creating block at depth ${depth}, received meshes:`, meshInfos);

  const min = minimum instanceof BABYLON.Vector3 
    ? minimum 
    : new BABYLON.Vector3(minimum.x, minimum.y, minimum.z);
  const max = maximum instanceof BABYLON.Vector3 
    ? maximum 
    : new BABYLON.Vector3(maximum.x, maximum.y, maximum.z);


     console.log('Block bounds:', {
            min: { x: min.x, y: min.y, z: min.z },
            max: { x: max.x, y: max.y, z: max.z }
        });

  // Create block
  const block = new BABYLON.OctreeBlock(min, max, [], parent);
  block.depth = depth;
  block.nodeNumber = nodeCounter++;

  // Assign meshes that overlap this block
    // In createOctreeBlock function
    const meshInfosInBlock = meshInfos.filter(meshInfo => {
      if (!meshInfo || !meshInfo.boundingInfo) return false;

      // Calculate center point of mesh
      const worldMin = BABYLON.Vector3.TransformCoordinates(
          new BABYLON.Vector3(
              meshInfo.boundingInfo.minimum.x,
              meshInfo.boundingInfo.minimum.y,
              meshInfo.boundingInfo.minimum.z
          ),
          BABYLON.Matrix.FromArray(meshInfo.transforms.worldMatrix)
      );

      const worldMax = BABYLON.Vector3.TransformCoordinates(
          new BABYLON.Vector3(
              meshInfo.boundingInfo.maximum.x,
              meshInfo.boundingInfo.maximum.y,
              meshInfo.boundingInfo.maximum.z
          ),
          BABYLON.Matrix.FromArray(meshInfo.transforms.worldMatrix)
      );

      const center = BABYLON.Vector3.Center(worldMin, worldMax);

      // Assign mesh to node only if its center point is inside the node
      return (
          center.x >= min.x && center.x <= max.x &&
          center.y >= min.y && center.y <= max.y &&
          center.z >= min.z && center.z <= max.z
      );
  });




  // Store mesh info in block
  block.meshInfos = meshInfosInBlock.map(info => ({
    id: info.metadata.id,
    boundingBox: info.boundingInfo
  }));
  block.customCapacity = meshInfosInBlock.length;

  // Update tracking
  nodesAtDepth[depth]++;
  nodeNumbersByDepth[depth].push(block.nodeNumber);
  nodeDepths.set(block.nodeNumber, block.meshInfos);
  nodeContents.set(block.nodeNumber, block.meshInfos);

  if (meshInfosInBlock.length > 0) {
    nodesAtDepthWithBoxes[depth]++;
    if (!boxesAtDepth[depth]) {
      boxesAtDepth[depth] = new Set();
    }
    meshInfosInBlock.forEach(meshInfo => {
      boxesAtDepth[depth].add(meshInfo.metadata.id);
    });
  }

  // Create child blocks if not at max depth
  if (depth < MAX_DEPTH) {
    const center = new BABYLON.Vector3(
      (min.x + max.x) / 2,
      (min.y + max.y) / 2,
      (min.z + max.z) / 2
    );

    block.blocks = [];

    // Create all 8 child blocks
    for (let x = 0; x < 2; x++) {
      for (let y = 0; y < 2; y++) {
        for (let z = 0; z < 2; z++) {
          const childMin = new BABYLON.Vector3(
            x === 0 ? min.x : center.x,
            y === 0 ? min.y : center.y,
            z === 0 ? min.z : center.z
          );
          const childMax = new BABYLON.Vector3(
            x === 0 ? center.x : max.x,
            y === 0 ? center.y : max.y,
            z === 0 ? center.z : max.z
          );

          const childMeshes = meshInfosInBlock.filter(meshInfo => {
            const worldMin = BABYLON.Vector3.TransformCoordinates(
              meshInfo.boundingInfo.minimum,
              BABYLON.Matrix.FromArray(meshInfo.transforms.worldMatrix)
            );
            const worldMax = BABYLON.Vector3.TransformCoordinates(
              meshInfo.boundingInfo.maximum,
              BABYLON.Matrix.FromArray(meshInfo.transforms.worldMatrix)
            );

            // Check if bounding box overlaps with the child block
            return !(
              worldMax.x < childMin.x || worldMin.x > childMax.x ||
              worldMax.y < childMin.y || worldMin.y > childMax.y ||
              worldMax.z < childMin.z || worldMin.z > childMax.z
            );
          });

          // Only create child block if it has meshes or can subdivide further
          if (childMeshes.length > 0 || depth + 1 < MAX_DEPTH) {
            const childBlock = createOctreeBlock(
              scene,
              childMin,
              childMax,
              childMeshes,
              depth + 1,
              block
            );
            block.blocks.push(childBlock);
            if (childBlock) {
              nodeParents.set(childBlock.nodeNumber, block.nodeNumber);
            }
          }
        }
      }
    }
  }

  return block;
};


//  createOctreeInfo function
export const createOctreeInfo = (octreeRoot, cumulativeMin, cumulativeMax) => {
    const totalMeshes = Object.values(boxesAtDepth).reduce((total, set) => total + set.size, 0);
    
    return {
      name: "mainOctree",
      data: {
        blockHierarchy: {
          bounds: {
            min: serializeVector3(cumulativeMin),
            max: serializeVector3(cumulativeMax)
          },
          meshInfos: octreeRoot.meshInfos || [],
          properties: {
            depth: 0,
            nodeNumber: 1,
            capacity: totalMeshes
          },
          relationships: {
            childBlocks: octreeRoot.blocks ? octreeRoot.blocks.map(child => 
              serializeBlock(child)
            ) : []
          }
        }
      },
      bounds: {
        min: serializeVector3(cumulativeMin),
        max: serializeVector3(cumulativeMax)
      },
      properties: {
        maxDepth: MAX_DEPTH,
        minSize: MIN_SIZE,
        totalNodes: nodeCounter,
        nodesPerLevel: Array(5).fill(0).map((_, i) => nodesAtDepth[i] || 0),
        nodesWithBoxes: nodesAtDepthWithBoxes
      },
      statistics: {
        totalMeshes,
        meshesPerLevel: Object.fromEntries(
          Object.entries(boxesAtDepth).map(([depth, set]) => [depth, set.size])
        ),
        nodeDistribution: Array(5).fill(0).map((_, i) => ({
          depth: i,
          totalNodes: nodesAtDepth[i] || 0,
          nodesWithContent: nodesAtDepthWithBoxes[i] || 0
        }))
      },
      name: "mainOctree",
  
      timestamp: new Date().toISOString()
    };
  };
  
  // Helper function to serialize a block
  const serializeBlock = (block) => {
    if (!block) return null;
  
    return {
      bounds: {
        min: serializeVector3(block.minPoint),
        max: serializeVector3(block.maxPoint)
      },
      meshInfos: block.meshInfos || [],
      properties: {
        depth: block.depth,
        nodeNumber: block.nodeNumber,
        capacity: block.meshInfos ? block.meshInfos.length : 0
      },
      relationships: {
        childBlocks: block.blocks ? block.blocks.map(child => 
          serializeBlock(child)
        ) : [],
        parentNode: block.parent ? block.parent.nodeNumber : null
      }
    };
  };
  
  // Helper function to maintain consistent vector serialization
  const serializeVector3 = (vector) => {
    return {
      x: vector.x,
      y: vector.y,
      z: vector.z
    };
  };


   export const distributeMeshesToOctree = (rootBlock, meshInfos) => {
      // First, distribute meshes to appropriate child blocks based on their centers
      const distributeToChildren = (block, meshes, depth) => {
        // Assign meshes that belong to this block
        block.meshInfos = meshes.map(info => ({
          id: info.metadata.id,
          boundingBox: info.boundingInfo
        }));
    
        // Update tracking for this node
        nodesAtDepth[depth]++;
        nodeNumbersByDepth[depth].push(block.nodeNumber);
        nodeDepths.set(block.nodeNumber, block.meshInfos);
        nodeContents.set(block.nodeNumber, block.meshInfos);
        
        if (block.meshInfos.length > 0) {
          nodesAtDepthWithBoxes[depth]++;
          if (!boxesAtDepth[depth]) {
            boxesAtDepth[depth] = new Set();
          }
          block.meshInfos.forEach(info => {
            boxesAtDepth[depth].add(info.id);
          });
        }
    
        // If we haven't reached max depth, subdivide
        if (depth < MAX_DEPTH && meshes.length > 0) {
          const center = BABYLON.Vector3.Center(block.minPoint, block.maxPoint);
          block.blocks = [];
    
          // Create 8 child blocks
          for (let x = 0; x < 2; x++) {
            for (let y = 0; y < 2; y++) {
              for (let z = 0; z < 2; z++) {
                const childMin = new BABYLON.Vector3(
                  x === 0 ? block.minPoint.x : center.x,
                  y === 0 ? block.minPoint.y : center.y,
                  z === 0 ? block.minPoint.z : center.z
                );
                const childMax = new BABYLON.Vector3(
                  x === 0 ? center.x : block.maxPoint.x,
                  y === 0 ? center.y : block.maxPoint.y,
                  z === 0 ? center.z : block.maxPoint.z
                );
    
                const childBlock = new BABYLON.OctreeBlock(childMin, childMax, [], block);
                childBlock.depth = depth + 1;
                childBlock.nodeNumber = nodeCounter++;
                nodeParents.set(childBlock.nodeNumber, block.nodeNumber);
    
                // Filter meshes for this child
                const childMeshes = meshes.filter(meshInfo => {
                  const worldCenter = BABYLON.Vector3.Center(
                    BABYLON.Vector3.TransformCoordinates(
                      new BABYLON.Vector3(
                        meshInfo.boundingInfo.minimum.x,
                        meshInfo.boundingInfo.minimum.y,
                        meshInfo.boundingInfo.minimum.z
                      ),
                      BABYLON.Matrix.FromArray(meshInfo.transforms.worldMatrix)
                    ),
                    BABYLON.Vector3.TransformCoordinates(
                      new BABYLON.Vector3(
                        meshInfo.boundingInfo.maximum.x,
                        meshInfo.boundingInfo.maximum.y,
                        meshInfo.boundingInfo.maximum.z
                      ),
                      BABYLON.Matrix.FromArray(meshInfo.transforms.worldMatrix)
                    )
                  );
    
                  return (
                    worldCenter.x >= childMin.x && worldCenter.x <= childMax.x &&
                    worldCenter.y >= childMin.y && worldCenter.y <= childMax.y &&
                    worldCenter.z >= childMin.z && worldCenter.z <= childMax.z
                  );
                });
    
                if (childMeshes.length > 0 || depth + 1 < MAX_DEPTH) {
                  distributeToChildren(childBlock, childMeshes, depth + 1);
                  block.blocks.push(childBlock);
                }
              }
            }
          }
        }
      };
    
      distributeToChildren(rootBlock, meshInfos, 0);
    };