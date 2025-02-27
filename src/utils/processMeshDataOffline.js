import * as BABYLON from "@babylonjs/core";

// Optimized offline mesh data processing
export const processMeshDataOffline = (meshDataArray) => {
    let totalVertices = 0;
    let totalIndices = 0;
  
    // Pre-calculate buffer sizes
    meshDataArray.forEach(mesh => {
        totalVertices += mesh.positions.length / 3;
        totalIndices += mesh.indices.length;
    });
  
    // Pre-allocate buffers
    const mergedPositions = new Float32Array(totalVertices * 3);
    const mergedIndices = new Uint32Array(totalIndices);
    const mergedNormals = new Float32Array(totalVertices * 3);
  
    let vertexOffset = 0;
    let indexOffset = 0;
  
    // Process each mesh
    meshDataArray.forEach(mesh => {
        const vertexCount = mesh.positions.length / 3;
        
        if (mesh.transforms) {
            // Calculate transformation matrix once
            const matrix = mesh.transforms.worldMatrix ? 
                BABYLON.Matrix.FromArray(mesh.transforms.worldMatrix) :
                BABYLON.Matrix.Compose(
                    new BABYLON.Vector3(...Object.values(mesh.transforms.scaling)),
                    BABYLON.Quaternion.FromEulerAngles(
                        mesh.transforms.rotation.x,
                        mesh.transforms.rotation.y,
                        mesh.transforms.rotation.z
                    ),
                    new BABYLON.Vector3(...Object.values(mesh.transforms.position))
                );
  
            // Transform vertices in batches
            const VERTEX_BATCH_SIZE = 1000;
            for (let i = 0; i < vertexCount; i += VERTEX_BATCH_SIZE) {
                const batchEnd = Math.min(i + VERTEX_BATCH_SIZE, vertexCount);
                for (let j = i; j < batchEnd; j++) {
                    const pos = BABYLON.Vector3.TransformCoordinates(
                        new BABYLON.Vector3(
                            mesh.positions[j * 3],
                            mesh.positions[j * 3 + 1],
                            mesh.positions[j * 3 + 2]
                        ),
                        matrix
                    );
                    const targetIndex = (vertexOffset + j) * 3;
                    mergedPositions[targetIndex] = pos.x;
                    mergedPositions[targetIndex + 1] = pos.y;
                    mergedPositions[targetIndex + 2] = pos.z;
                }
            }
        } else {
            mergedPositions.set(mesh.positions, vertexOffset * 3);
        }
  
        // Update indices
        for (let i = 0; i < mesh.indices.length; i++) {
            mergedIndices[indexOffset + i] = mesh.indices[i] + vertexOffset;
        }
  
        if (mesh.normals) {
            mergedNormals.set(mesh.normals, vertexOffset * 3);
        }
  
        vertexOffset += vertexCount;
        indexOffset += mesh.indices.length;
    });
  
    return {
        positions: mergedPositions,
        indices: mergedIndices,
        normals: mergedNormals
    };
  };