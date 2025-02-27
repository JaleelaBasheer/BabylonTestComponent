import { initDB } from "./DbInit";
import { processMeshDataOffline } from "./processMeshDataOffline";
const TARGET_DEPTH = 4;


export const loadModels = async () => {
    console.log('Starting to process models...');

    try {
        const db = await initDB();
        console.log('Database initialized:', db.name, db.version);
        
        const tx = db.transaction(['octree', 'lowPolyMeshes'], 'readonly');
        console.log('Started transaction for reading data');
        
        const [octreeData, lowPolyModels] = await Promise.all([
            tx.objectStore('octree').get('mainOctree'),
            tx.objectStore('lowPolyMeshes').getAll()
        ]);

        if (!octreeData?.data) {
            throw new Error('No octree data found');
        }

        // Collect depth 4 nodes and validate they exist in octree
        const depth4Nodes = [];
        const stack = [{block: octreeData.data.blockHierarchy, depth: 0}];
        const validNodeNumbers = new Set();
        
        while (stack.length > 0) {
            const {block, depth} = stack.pop();
            
            if (depth === TARGET_DEPTH) {
                validNodeNumbers.add(block.properties.nodeNumber);
                if (block.meshInfos?.length > 0) {
                    depth4Nodes.push({
                        nodeNumber: block.properties.nodeNumber,
                        meshIds: block.meshInfos.map(info => info.id),
                        bounds: block.bounds
                    });
                }
            } else if (depth < TARGET_DEPTH && block.relationships?.childBlocks) {
                stack.push(...block.relationships.childBlocks.map(child => ({
                    block: child,
                    depth: depth + 1
                })));
            }
        }

        // console.log('Valid node numbers:', Array.from(validNodeNumbers).sort((a, b) => a - b));

        // Create model lookup map
        const modelMap = new Map();
        lowPolyModels.forEach(model => {
            if (model.fileName) {
                modelMap.set(model.fileName, model);
            }
            if (model.data?.metadata?.id) {
                modelMap.set(model.data.metadata.id, model);
            }
        });

        const CHUNK_SIZE = 10;
        const chunks = [];
        for (let i = 0; i < depth4Nodes.length; i += CHUNK_SIZE) {
            chunks.push(depth4Nodes.slice(i, i + CHUNK_SIZE));
        }

        const highCoverageMeshes = [];
        const lowCoverageMeshes = [];
        let processedCount = 0;

        // Process chunks
        for (const chunk of chunks) {
            const chunkData = await Promise.all(chunk.map(async node => {
                // Verify node exists in octree
                if (!validNodeNumbers.has(node.nodeNumber)) {
                    console.warn(`Skipping node ${node.nodeNumber} - not found in octree at depth ${TARGET_DEPTH}`);
                    return null;
                }

                const highCoverageBatch = [];
                const lowCoverageBatch = [];
                const highCoverageKeys = [];
                const lowCoverageKeys = [];
                
                for (const meshId of node.meshIds) {
                    let model = modelMap.get(meshId);
                    
                    if (!model) {
                        const matchingKey = Array.from(modelMap.keys()).find(key => 
                            key.includes(meshId)
                        );
                        if (matchingKey) {
                            model = modelMap.get(matchingKey);
                        }
                    }
                
                    if (model) {
                        const meshData = {
                            positions: new Float32Array(model.data.positions),
                            indices: new Uint32Array(model.data.indices),
                            normals: model.data.normals ? 
                                new Float32Array(model.data.normals) : null,
                            transforms: model.data.transforms
                        };

                        const meshInfo = {
                            meshId: meshId,
                            fileName: model.fileName,
                            metadataId: model.data.metadata.id,
                            screenCoverage: model.data.metadata.screenCoverage,
                            name:model.data.name
                        };

                        if (model.data.metadata.screenCoverage >1) {
                            highCoverageBatch.push(meshData);
                            highCoverageKeys.push(meshInfo);
                        } else {
                            lowCoverageBatch.push(meshData);
                            lowCoverageKeys.push(meshInfo);
                        }
                    }
                }

                const results = {
                    high: null,
                    low: null
                };

                // Process high coverage meshes
                if (highCoverageBatch.length > 0) {
                    const mergedVertexData = processMeshDataOffline(highCoverageBatch);
                    results.high = {
                        name: `merged_lowpoly_${node.nodeNumber}`,
                        vertexData: mergedVertexData,
                        transforms: {
                            position: { x: 0, y: 0, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scaling: { x: 1, y: 1, z: 1 },
                            worldMatrix: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]
                        },
                        metadata: {
                            nodeNumber: node.nodeNumber,
                            originalMeshCount: highCoverageBatch.length,
                            bounds: node.bounds,
                            originalMeshKeys: highCoverageKeys,
                        }
                    };
                }

                // Process low coverage meshes
                if (lowCoverageBatch.length > 0) {
                    const mergedVertexData = processMeshDataOffline(lowCoverageBatch);
                    results.low = {
                        name: `merged_skipped_${node.nodeNumber}`,
                        vertexData: mergedVertexData,
                        transforms: {
                            position: { x: 0, y: 0, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scaling: { x: 1, y: 1, z: 1 },
                            worldMatrix: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]
                        },
                        metadata: {
                            nodeNumber: node.nodeNumber,
                            originalMeshCount: lowCoverageBatch.length,
                            bounds: node.bounds,
                            originalMeshKeys: lowCoverageKeys
                        }
                    };
                }

                return results;
            }));

            // Collect results
            chunkData.forEach(results => {
                if (results?.high) highCoverageMeshes.push(results.high);
                if (results?.low) lowCoverageMeshes.push(results.low);
            });
            
            processedCount += chunk.length;
            console.log(`Processed ${processedCount} of ${depth4Nodes.length} nodes`);

            await new Promise(resolve => setTimeout(resolve, 0));
        }

        // Store results
        const STORE_CHUNK_SIZE = 50;
        const storeTx = db.transaction(['mergedlowPoly', 'mergedSkippedMeshes', 'octree'], 'readwrite');
        const highCoverageStore = storeTx.objectStore('mergedlowPoly');
        const lowCoverageStore = storeTx.objectStore('mergedSkippedMeshes');
        const octreeStore = storeTx.objectStore('octree');

        // Store high coverage meshes
        for (let i = 0; i < highCoverageMeshes.length; i += STORE_CHUNK_SIZE) {
            const storeChunk = highCoverageMeshes.slice(i, i + STORE_CHUNK_SIZE);
            await Promise.all(
                storeChunk.map(async data => {
                    await highCoverageStore.put(data, data.name);
                    // updateOctreeNode(
                    //     octreeData.data.blockHierarchy,
                    //     data.metadata.nodeNumber,
                    //     data.name,
                    //     'mergedlowPoly'
                    // );
                })
            );
        }

        // Store low coverage meshes
        for (let i = 0; i < lowCoverageMeshes.length; i += STORE_CHUNK_SIZE) {
            const storeChunk = lowCoverageMeshes.slice(i, i + STORE_CHUNK_SIZE);
            await Promise.all(
                storeChunk.map(async data => {
                    await lowCoverageStore.put(data, data.name);
                    // updateOctreeNode(
                    //     octreeData.data.blockHierarchy,
                    //     data.metadata.nodeNumber,
                    //     data.name,
                    //     'mergedSkippedMeshes'
                    // );
                })
            );
        }

        // Update octree after all meshes are stored
        await octreeStore.put(octreeData, 'mainOctree');
        await storeTx.done;

        // Verify storage
        const verifyTx = db.transaction(['mergedlowPoly', 'mergedSkippedMeshes'], 'readonly');
        const highCount = await verifyTx.objectStore('mergedlowPoly').count();
        const lowCount = await verifyTx.objectStore('mergedSkippedMeshes').count();
        console.log('Verified stored mesh counts:', {
            highCoverage: highCount,
            lowCoverage: lowCount
        });

    } catch (error) {
        console.error('Error in loadModels:', error);
        throw error;
    }
};

function updateOctreeNode(block, targetNodeNumber, meshKey, meshType, depth = 0) {
    if (depth === TARGET_DEPTH && block.properties.nodeNumber === targetNodeNumber) {
        block.meshInfos.push({
            id: meshKey,
            type: meshType
        });
        return true;
    }
    
    if (depth < TARGET_DEPTH && block.relationships?.childBlocks) {
        for (const child of block.relationships.childBlocks) {
            if (updateOctreeNode(child, targetNodeNumber, meshKey, meshType, depth + 1)) {
                return true;
            }
        }
    }
    return false;
}

// import { initDB } from "./DbInit";
// import { processMeshDataOffline } from "./processMeshDataOffline";
// const TARGET_DEPTH = 4;

// export const loadModels = async () => {
// //   setIsLoading(true);
//   console.log('Starting to process models...');

//   try {
//       const db = await initDB();
//       console.log('Database initialized:', db.name, db.version);
      
//       const tx = db.transaction(['octree', 'lowPolyMeshes'], 'readonly');
//       console.log('Started transaction for reading data');
      
//       const [octreeData, lowPolyModels] = await Promise.all([
//           tx.objectStore('octree').get('mainOctree'),
//           tx.objectStore('lowPolyMeshes').getAll()
//       ]);

//       console.log('Octree data loaded:', octreeData ? 'Yes' : 'No');
//       console.log('LowPoly models loaded:', lowPolyModels.length);

//       if (!octreeData?.data) {
//           throw new Error('No octree data found');
//       }

//       // Collect depth 4 nodes
//       const depth4Nodes = [];
//       const stack = [{block: octreeData.data.blockHierarchy, depth: 0}];
      
//       while (stack.length > 0) {
//           const {block, depth} = stack.pop();
          
//           if (depth === TARGET_DEPTH && block.meshInfos?.length > 0) {
//               depth4Nodes.push({
//                   nodeNumber: block.properties.nodeNumber,
//                   meshIds: block.meshInfos.map(info => info.id),
//                   bounds: block.bounds
//               });
//           } else if (depth < TARGET_DEPTH && block.relationships?.childBlocks) {
//               stack.push(...block.relationships.childBlocks.map(child => ({
//                   block: child,
//                   depth: depth + 1
//               })));
//           }
//       }

//       console.log('Found depth 4 nodes:', depth4Nodes.length);
//       console.log('Sample node:', depth4Nodes[0]);

//       // Create model lookup map
//       const modelMap = new Map();
//   lowPolyModels.forEach(model => {
//     // Add both fileName and metadata.id as possible keys
//     if (model.fileName) {
//         modelMap.set(model.fileName, model);
//     }
//     if (model.data?.metadata?.id) {
//         modelMap.set(model.data.metadata.id, model);
//     }
// });

//       console.log('Model map size:', modelMap.size);

//       const CHUNK_SIZE = 20;
//       const chunks = [];
//       for (let i = 0; i < depth4Nodes.length; i += CHUNK_SIZE) {
//           chunks.push(depth4Nodes.slice(i, i + CHUNK_SIZE));
//       }

//       console.log('Number of chunks to process:', chunks.length);
//       const mergedMeshesData = [];
//       let processedCount = 0;

//       // Process chunks
//       for (const chunk of chunks) {
//         const chunkData = await Promise.all(chunk.map(async node => {
//             const meshesGroupedByFile = new Map(); // Group meshes by fileId
//             console.log('Processing node:', node.nodeNumber, 'with meshIds:', node.meshIds);
            
//             // First, collect and group mesh data by file
//             for (const meshId of node.meshIds) {
//                 console.log('Looking for meshId:', meshId);
                
//                 let model = modelMap.get(meshId);
//                 if (!model) {
//                     const matchingKey = Array.from(modelMap.keys()).find(key => 
//                         key.includes(meshId)
//                     );
//                     if (matchingKey) {
//                         model = modelMap.get(matchingKey);
//                         console.log('Found model through partial match:', matchingKey);
//                     }
//                 }
    
//                 if (model && model.data?.metadata?.screenCoverage > 0.5) {
//                     const fileId = model.data.metadata.fileId; // Get fileId from metadata
//                     if (!meshesGroupedByFile.has(fileId)) {
//                         meshesGroupedByFile.set(fileId, {
//                             meshes: [],
//                             originalKeys: []
//                         });
//                     }
    
//                     meshesGroupedByFile.get(fileId).meshes.push({
//                         positions: new Float32Array(model.data.positions),
//                         indices: new Uint32Array(model.data.indices),
//                         normals: model.data.normals ? 
//                             new Float32Array(model.data.normals) : null,
//                         transforms: model.data.transforms
//                     });
    
//                     meshesGroupedByFile.get(fileId).originalKeys.push({
//                         meshId: meshId,
//                         fileName: model.fileName,
//                         metadataId: model.data.metadata.id,
//                         screenCoverage: model.data.metadata.screenCoverage
//                     });
//                 }
//             }
    
//             // Process each file group separately
//             const mergedResults = [];
//             for (const [fileId, groupData] of meshesGroupedByFile.entries()) {
//                 if (groupData.meshes.length > 0) {
//                     const mergedVertexData = processMeshDataOffline(groupData.meshes);
//                     console.log('Merged vertex data for file:', fileId, 'in node:', node.nodeNumber, {
//                         positions: mergedVertexData.positions.length,
//                         indices: mergedVertexData.indices.length,
//                         normals: mergedVertexData.normals?.length
//                     });
    
//                     mergedResults.push({
//                         name: `merged_lowpoly_${fileId}_${node.nodeNumber}`,
//                         vertexData: mergedVertexData,
//                         transforms: {
//                             position: { x: 0, y: 0, z: 0 },
//                             rotation: { x: 0, y: 0, z: 0 },
//                             scaling: { x: 1, y: 1, z: 1 },
//                             worldMatrix: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]
//                         },
//                         metadata: {
//                             nodeNumber: node.nodeNumber,
//                             fileId: fileId,
//                             originalMeshCount: groupData.meshes.length,
//                             bounds: node.bounds,
//                             originalMeshKeys: groupData.originalKeys
//                         }
//                     });
//                 }
//             }
    
//             return mergedResults;
//         }));
    
//         // Flatten the results since each node now might return multiple merged meshes
//         const validResults = chunkData.flat().filter(Boolean);
//         console.log('Valid results in chunk:', validResults.length);
//         mergedMeshesData.push(...validResults);
        
//         processedCount += chunk.length;
//         console.log(`Processed ${processedCount} of ${depth4Nodes.length} nodes`);
    
//         await new Promise(resolve => setTimeout(resolve, 0));
//     }
//       console.log('Total merged meshes data:', mergedMeshesData.length);

//       // Store results
//       if (mergedMeshesData.length > 0) {
//           const STORE_CHUNK_SIZE = 50;
//           const storeTx = db.transaction('mergedlowPoly', 'readwrite');
//           const store = storeTx.objectStore('mergedlowPoly');
//           console.log('Started storage transaction');

//           for (let i = 0; i < mergedMeshesData.length; i += STORE_CHUNK_SIZE) {
//             const storeChunk = mergedMeshesData.slice(i, i + STORE_CHUNK_SIZE);
//             console.log('Storing chunk:', i / STORE_CHUNK_SIZE + 1, 'of', 
//                 Math.ceil(mergedMeshesData.length / STORE_CHUNK_SIZE));
            
//             try {
//                 await Promise.all(
//                     storeChunk.map(async data => {
//                         const key = `merged_lowpoly_${data.metadata.fileId}_${data.metadata.nodeNumber}`;
//                         console.log('Storing mesh data with key:', key);
//                         await store.put(data, key);
//                     })
//                 );
//                 console.log('Successfully stored chunk');
//             } catch (error) {
//                 console.error('Error storing chunk:', error);
//                 throw error;
//             }
//         }

//           try {
//               await storeTx.done;
//               console.log('Storage transaction completed successfully');
              
//               // Verify storage
//               const verifyTx = db.transaction('mergedlowPoly', 'readonly');
//               const verifyStore = verifyTx.objectStore('mergedlowPoly');
//               const storedCount = await verifyStore.count();
//               console.log('Verified stored mesh count:', storedCount);
//           } catch (error) {
//               console.error('Transaction completion error:', error);
//               throw error;
//           }
//       }

//   } catch (error) {
//       console.error('Error in loadModels:', error);
//   } finally {
//     //   setIsLoading(false);
//   }
// };


// import { initDB } from "./DbInit";
// import { processMeshDataOffline } from "./processMeshDataOffline";
// import * as BABYLON from '@babylonjs/core';

// const TARGET_DEPTH = 4;

// // Function to convert mesh data to ArrayBuffer
// const convertMeshToArrayBuffer = (vertexData, transforms, metadata) => {
//     // Create an object with all the mesh data
//     const meshData = {
//         positions: Array.from(vertexData.positions),
//         indices: Array.from(vertexData.indices),
//         normals: vertexData.normals ? Array.from(vertexData.normals) : null,
//         transforms: transforms,
//         metadata: metadata
//     };

//     // Convert to JSON string
//     const jsonString = JSON.stringify(meshData);
    
//     // Convert to ArrayBuffer
//     const encoder = new TextEncoder();
//     const arrayBuffer = encoder.encode(jsonString).buffer;
    
//     return arrayBuffer;
// };

// export const loadModels = async () => {
//     console.log('Starting to process models...');

//     try {
//         const db = await initDB();
//         console.log('Database initialized:', db.name, db.version);
        
//         const tx = db.transaction(['octree', 'lowPolyMeshes'], 'readonly');
//         const [octreeData, lowPolyModels] = await Promise.all([
//             tx.objectStore('octree').get('mainOctree'),
//             tx.objectStore('lowPolyMeshes').getAll()
//         ]);

//         if (!octreeData?.data) {
//             throw new Error('No octree data found');
//         }
//                   // Collect depth 4 nodes
//                   const depth4Nodes = [];
//                   const stack = [{block: octreeData.data.blockHierarchy, depth: 0}];
                  
//                   while (stack.length > 0) {
//                       const {block, depth} = stack.pop();
                      
//                       if (depth === TARGET_DEPTH && block.meshInfos?.length > 0) {
//                           depth4Nodes.push({
//                               nodeNumber: block.properties.nodeNumber,
//                               meshIds: block.meshInfos.map(info => info.id),
//                               bounds: block.bounds
//                           });
//                       } else if (depth < TARGET_DEPTH && block.relationships?.childBlocks) {
//                           stack.push(...block.relationships.childBlocks.map(child => ({
//                               block: child,
//                               depth: depth + 1
//                           })));
//                       }
//                   }
            
//                   console.log('Found depth 4 nodes:', depth4Nodes.length);
//                   console.log('Sample node:', depth4Nodes[0]);
            
//                   // Create model lookup map
//                   const modelMap = new Map();
//               lowPolyModels.forEach(model => {
//                 // Add both fileName and metadata.id as possible keys
//                 if (model.fileName) {
//                     modelMap.set(model.fileName, model);
//                 }
//                 if (model.data?.metadata?.id) {
//                     modelMap.set(model.data.metadata.id, model);
//                 }
//             });
            
//                   console.log('Model map size:', modelMap.size);
            
//                   const CHUNK_SIZE = 20;
//                   const chunks = [];
//                   for (let i = 0; i < depth4Nodes.length; i += CHUNK_SIZE) {
//                       chunks.push(depth4Nodes.slice(i, i + CHUNK_SIZE));
//                   }
            
//                   console.log('Number of chunks to process:', chunks.length);
//                   const mergedMeshesData = [];
//                   let processedCount = 0;
            
//                   // Process chunks
//                   for (const chunk of chunks) {
//                       const chunkData = await Promise.all(chunk.map(async node => {
//                           const meshesForNode = [];
//                           console.log('Processing node:', node.nodeNumber, 'with meshIds:', node.meshIds);
                          
//                           // Collect mesh data
//                           for (const meshId of node.meshIds) {
//                             // Log the current meshId we're looking for
//                             console.log('Looking for meshId:', meshId);
                            
//                             // Try direct lookup first
//                             let model = modelMap.get(meshId);
                            
//                             // If not found, try partial matching like in original code
//                             if (!model) {
//                                 const matchingKey = Array.from(modelMap.keys()).find(key => 
//                                     key.includes(meshId)
//                                 );
//                                 if (matchingKey) {
//                                     model = modelMap.get(matchingKey);
//                                     console.log('Found model through partial match:', matchingKey);
//                                 }
//                             }
                        
//                             if (model && model.data?.metadata?.screenCoverage > 0.01) {
//                               console.log('Found matching model with sufficient screen coverage:', {
//                                   meshId,
//                                   fileName: model.fileName,
//                                   metadataId: model.data?.metadata?.id,
//                                   screenCoverage: model.data.metadata.screenCoverage
//                               });
//                                 meshesForNode.push({
//                                     positions: new Float32Array(model.data.positions),
//                                     indices: new Uint32Array(model.data.indices),
//                                     normals: model.data.normals ? 
//                                         new Float32Array(model.data.normals) : null,
//                                     transforms: model.data.transforms
//                                 });
//                             } else {
//                                 console.warn('No matching model found for meshId:', meshId);
//                             }
//                         }
            
//                           if (meshesForNode.length > 0) {
//                               const mergedVertexData = processMeshDataOffline(meshesForNode);
//                               console.log('Merged vertex data for node:', node.nodeNumber, {
//                                   positions: mergedVertexData.positions.length,
//                                   indices: mergedVertexData.indices.length,
//                                   normals: mergedVertexData.normals?.length
//                               });
                              
//                               // Store the original mesh keys/IDs that were used in this merge
//                               const originalMeshKeys = node.meshIds.map(meshId => {
//                                   // Try to get both the fileName and metadata.id if they exist
//                                   const model = modelMap.get(meshId) || Array.from(modelMap.entries())
//                                       .find(([key]) => key.includes(meshId))?.[1];
                                  
//                                   return {
//                                       meshId: meshId,
//                                       fileName: model?.fileName,
//                                       metadataId: model?.data?.metadata?.id,
//                                       screenCoverage: model?.data?.metadata?.screenCoverage,
//                                       originalMeshKeys: model?.data?.metadata?.originalMeshKeys || [],
//                                   };
//                               });
                              
//                               return {
//                                 name: `lpoly_node_${node.nodeNumber}`,
//                                 vertexData: mergedVertexData,
//                                 // Add default transforms if none exist
//                                 transforms: {
//                                     position: { x: 0, y: 0, z: 0 },
//                                     rotation: { x: 0, y: 0, z: 0 },
//                                     scaling: { x: 1, y: 1, z: 1 },
//                                     worldMatrix: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1] // Identity matrix as default
//                                 },
//                                 metadata: {
//                                     nodeNumber: node.nodeNumber,
//                                     originalMeshCount: meshesForNode.length,
//                                     bounds: node.bounds,
//                                     originalMeshKeys: originalMeshKeys, // Add the original mesh keys to metadata
//                                 }
//                             };
//                           }
//                           return null;
//                       }));
            
//                       // Add valid results to final array
//                       const validResults = chunkData.filter(Boolean);
//                       console.log('Valid results in chunk:', validResults.length);
//                       mergedMeshesData.push(...validResults);
                      
//                       processedCount += chunk.length;
//                       console.log(`Processed ${processedCount} of ${depth4Nodes.length} nodes`);
            
//                       await new Promise(resolve => setTimeout(resolve, 0));
//                   }
            
//                   console.log('Total merged meshes data:', mergedMeshesData.length);
            
//                   // Store results
//                   if (mergedMeshesData.length > 0) {
//                     const STORE_CHUNK_SIZE = 50;
//                     const storeTx = db.transaction('mergedMeshArrayBuffer', 'readwrite');
//                     const store = storeTx.objectStore('mergedMeshArrayBuffer');
//                     console.log('Started storage transaction for binary files');
        
//                     for (let i = 0; i < mergedMeshesData.length; i += STORE_CHUNK_SIZE) {
//                         const storeChunk = mergedMeshesData.slice(i, i + STORE_CHUNK_SIZE);
//                         console.log('Processing binary chunk:', i / STORE_CHUNK_SIZE + 1, 'of', 
//                             Math.ceil(mergedMeshesData.length / STORE_CHUNK_SIZE));
                        
//                         try {
//                             await Promise.all(
//                                 storeChunk.map(async data => {
//                                     const key = `merged_node_${data.metadata.nodeNumber}`;
//                                     console.log('Converting mesh to binary:', key);
                                    
//                                     // Convert to ArrayBuffer
//                                     const arrayBuffer = convertMeshToArrayBuffer(
//                                         data.vertexData,
//                                         data.transforms,
//                                         data.metadata
//                                     );
                                    
//                                     // Store array buffer data
//                                     await store.put({
//                                         arrayBuffer: arrayBuffer,
//                                         metadata: data.metadata,
//                                         fileName: key
//                                     }, key);
                                    
//                                     console.log('Successfully stored binary:', key);
//                                 })
//                             );
//                             console.log('Successfully stored binary chunk');
//                         } catch (error) {
//                             console.error('Error storing binary chunk:', error);
//                             throw error;
//                         }
//                     }
        
//                     try {
//                         await storeTx.done;
//                         console.log('Binary storage transaction completed successfully');
                        
//                         // Verify storage
//                         const verifyTx = db.transaction('mergedMeshArrayBuffer', 'readonly');
//                         const verifyStore = verifyTx.objectStore('mergedMeshArrayBuffer');
//                         const storedCount = await verifyStore.count();
//                         console.log('Verified stored binary count:', storedCount);
//                     } catch (error) {
//                         console.error('Transaction completion error:', error);
//                         throw error;
//                     }
//                 }
//             } catch (error) {
//                 console.error('Error in loadModels:', error);
//             }
//         };
