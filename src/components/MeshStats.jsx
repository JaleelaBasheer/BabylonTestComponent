import React, { useState, useEffect } from 'react';

const MeshMerger = () => {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const calculateMeshSize = (mesh) => {
      let totalBytes = 0;
      if (mesh.vertexData.positions) totalBytes += mesh.vertexData.positions.length * 4;
      if (mesh.vertexData.indices) totalBytes += mesh.vertexData.indices.length * 4;
      if (mesh.vertexData.normals) totalBytes += mesh.vertexData.normals.length * 4;
      return totalBytes;
    };

    // const calculateMeshSize = (mesh) => {
    //   let totalBytes = 0;
    //   if (mesh.data.positions) totalBytes += mesh.data.positions.length * 4;
    //   if (mesh.data.indices) totalBytes += mesh.data.indices.length * 4;
    //   if (mesh.data.normals) totalBytes += mesh.data.normals.length * 4;
    //   return totalBytes;
    // };

    const formatBytes = (bytes) => {
      if (bytes === 0) return '0 Bytes';
      const k = 1024;
      const sizes = ['Bytes', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    const mergeMeshes = async () => {
      try {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('TestingStorage', 2);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
        });

        const transaction = db.transaction(['mergedlowPoly'], 'readonly');
        const store = transaction.objectStore('mergedlowPoly');
        
        const lowPolyModels = await new Promise((resolve, reject) => {
          const request = store.getAll();
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
        });


        let totalSize = 0;
       

        // Process each model
        lowPolyModels.forEach(model => {
          const size = calculateMeshSize(model);
          totalSize += size;

        });

        
        setStats({
          totalMeshes: lowPolyModels.length,
          totalSize: formatBytes(totalSize),
          
        });

      } catch (err) {
        setError(err.message);
      }
    };

    mergeMeshes();
  }, []);

  if (error) {
    return (
      <div className="text-red-500 p-4">
        Error merging meshes: {error}
      </div>
    );
  }

  return (
    <div className="w-full max-w-md bg-white shadow-lg rounded-lg p-6">
      <h2 className="text-xl font-bold text-gray-800 mb-4">Mesh Statistics</h2>
      
      {stats ? (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <span className="text-gray-600">Total Meshes:</span>
            <span className="font-semibold">{stats.totalMeshes}</span>
          </div>
          
          <div className="flex justify-between items-center">
            <span className="text-gray-600">Total Size:</span>
            <span className="font-semibold">{stats.totalSize}</span>
          </div>
          
         
          
          
        </div>
      ) : (
        <div className="flex justify-center items-center h-24">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
        </div>
      )}
    </div>
  );
};

export default MeshMerger;

// import React, { useState, useEffect, useRef } from 'react';
// import * as BABYLON from '@babylonjs/core';
// import MeshOptimizer from './MeshOptimizer';

// const OptimizedModelLoader = () => {
//   const [status, setStatus] = useState('');
//   const [isLoading, setIsLoading] = useState(false);
//   const [stats, setStats] = useState(null);
//   const sceneRef = useRef(null);
//   const engineRef = useRef(null);
//   const canvasRef = useRef(null);

//   // Initialize scene
//   useEffect(() => {
//     const container = document.createElement('div');
//     container.style.width = '100%';
//     container.style.height = '600px';
//     container.style.position = 'relative';
//     document.body.appendChild(container);

//     const canvas = document.createElement('canvas');
//     canvas.style.width = '100%';
//     canvas.style.height = '100%';
//     container.appendChild(canvas);
//     canvasRef.current = canvas;

//     const engine = new BABYLON.Engine(canvas, true);
//     engineRef.current = engine;
    
//     const scene = new BABYLON.Scene(engine);
//     sceneRef.current = scene;

//     const camera = new BABYLON.ArcRotateCamera(
//       "camera",
//       0,
//       Math.PI / 3,
//       10,
//       BABYLON.Vector3.Zero(),
//       scene
//     );
//     camera.attachControl(canvas, true);

//     const light = new BABYLON.HemisphericLight(
//       "light",
//       new BABYLON.Vector3(0, 1, 0),
//       scene
//     );

//     engine.runRenderLoop(() => {
//       scene.render();
//     });

//     window.addEventListener('resize', () => {
//       engine.resize();
//     });

//     return () => {
//       engine.dispose();
//       scene.dispose();
//       container.remove();
//     };
//   }, []);

//   const initDB = async () => {
//     return new Promise((resolve, reject) => {
//       const request = indexedDB.open('TestStorage', 2);
//       request.onerror = () => reject(request.error);
//       request.onsuccess = () => resolve(request.result);
//       request.onupgradeneeded = (event) => {
//         const db = event.target.result;
//         if (!db.objectStoreNames.contains('optimizedMeshes')) {
//           db.createObjectStore('optimizedMeshes', { keyPath: 'id' });
//         }
//       };
//     });
//   };

//   const formatBytes = (bytes) => {
//     if (bytes === 0) return '0 Bytes';
//     const k = 1024;
//     const sizes = ['Bytes', 'KB', 'MB'];
//     const i = Math.floor(Math.log(bytes) / Math.log(k));
//     return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
//   };

//   const calculateMeshSize = (mesh) => {
//     let size = 0;
//     if (mesh.positions) size += mesh.positions.length * 4;
//     if (mesh.indices) size += mesh.indices.length * 4;
//     if (mesh.normals) size += mesh.normals.length * 4;
//     return size;
//   };

//   const loadOptimizedModels = async () => {
//     if (!sceneRef.current || !engineRef.current) {
//       setStatus('Error: Scene not initialized');
//       return;
//     }

//     setIsLoading(true);
//     setStatus('Loading optimized models...');

//     try {
//       const db = await initDB();
//       const store = db.transaction('optimizedMeshes', 'readonly').objectStore('optimizedMeshes');
//       const models = await new Promise((resolve, reject) => {
//         const request = store.getAll();
//         request.onsuccess = () => resolve(request.result);
//         request.onerror = () => reject(request.error);
//       });

//       // Clear existing meshes
//       sceneRef.current.meshes.slice().forEach(mesh => mesh.dispose());

//       const material = new BABYLON.StandardMaterial("mat", sceneRef.current);
//       material.diffuseColor = new BABYLON.Color3(0.7, 0.7, 0.7);
//       material.backFaceCulling = false;

//       // Track bounds for camera positioning
//       let minX = Infinity, minY = Infinity, minZ = Infinity;
//       let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

//       let loadedCount = 0;
//       for (const model of models) {
//         const mesh = new BABYLON.Mesh(`optimized_${loadedCount}`, sceneRef.current);
//         const vertexData = new BABYLON.VertexData();

//         vertexData.positions = new Float32Array(model.positions);
//         vertexData.indices = new Uint32Array(model.indices);
//         if (model.normals) {
//           vertexData.normals = new Float32Array(model.normals);
//         }

//         vertexData.applyToMesh(mesh);
//         mesh.material = material;

//         // Update bounds
//         for (let i = 0; i < model.positions.length; i += 3) {
//           const x = model.positions[i];
//           const y = model.positions[i + 1];
//           const z = model.positions[i + 2];
          
//           minX = Math.min(minX, x);
//           minY = Math.min(minY, y);
//           minZ = Math.min(minZ, z);
//           maxX = Math.max(maxX, x);
//           maxY = Math.max(maxY, y);
//           maxZ = Math.max(maxZ, z);
//         }

//         loadedCount++;
//       }

//       // Position camera
//       if (sceneRef.current.activeCamera) {
//         const camera = sceneRef.current.activeCamera;
//         const center = new BABYLON.Vector3(
//           (maxX + minX) / 2,
//           (maxY + minY) / 2,
//           (maxZ + minZ) / 2
//         );
        
//         const diagonal = Math.sqrt(
//           Math.pow(maxX - minX, 2) +
//           Math.pow(maxY - minY, 2) +
//           Math.pow(maxZ - minZ, 2)
//         );

//         camera.radius = diagonal * 1.5;
//         camera.setTarget(center);
//       }

//       setStatus(`Successfully loaded ${loadedCount} optimized models`);
//     } catch (error) {
//       console.error('Error loading optimized models:', error);
//       setStatus(`Error: ${error.message}`);
//     } finally {
//       setIsLoading(false);
//     }
//   };

//   const optimizeAndLoadModels = async () => {
//     setIsLoading(true);
//     setStatus('Starting optimization...');

//     try {
//       const db = await initDB();
//       const store = db.transaction('lowPolyMeshes', 'readonly').objectStore('lowPolyMeshes');
//       const models = await new Promise((resolve, reject) => {
//         const request = store.getAll();
//         request.onsuccess = () => resolve(request.result);
//         request.onerror = () => reject(request.error);
//       });

//       let totalOriginalSize = 0;
//       let totalOptimizedSize = 0;
//       let optimizedModels = [];

//       for (const model of models) {
//         const originalSize = calculateMeshSize(model);
//         totalOriginalSize += originalSize;

//         const optimized = MeshOptimizer.optimizeMesh(model);
//         const optimizedSize = calculateMeshSize(optimized);
//         totalOptimizedSize += optimizedSize;

//         optimizedModels.push({
//           id: `opt_${model.id || Date.now()}_${optimizedModels.length}`,
//           originalId: model.id,
//           positions: optimized.positions,
//           indices: optimized.indices,
//           normals: optimized.normals,
//           metadata: {
//             originalSize: originalSize,
//             optimizedSize: optimizedSize,
//             reduction: ((originalSize - optimizedSize) / originalSize * 100).toFixed(2)
//           }
//         });
//       }

//       const optimizedStore = db.transaction('optimizedMeshes', 'readwrite')
//                               .objectStore('optimizedMeshes');
      
//       for (const model of optimizedModels) {
//         await new Promise((resolve, reject) => {
//           const request = optimizedStore.put(model);
//           request.onsuccess = () => resolve();
//           request.onerror = () => reject(request.error);
//         });
//       }

//       setStats({
//         originalSize: formatBytes(totalOriginalSize),
//         optimizedSize: formatBytes(totalOptimizedSize),
//         reduction: ((totalOriginalSize - totalOptimizedSize) / totalOriginalSize * 100).toFixed(2),
//         modelCount: models.length
//       });

//       setStatus('Optimization complete - Models stored in optimizedMeshes store');
//     } catch (error) {
//       console.error('Optimization error:', error);
//       setStatus(`Error: ${error.message}`);
//     } finally {
//       setIsLoading(false);
//     }
//   };

//   return (
//     <div className="p-4 space-y-4">
//       <div className="flex gap-4">
//         <button
//           onClick={optimizeAndLoadModels}
//           disabled={isLoading}
//           className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 
//                    disabled:bg-blue-300 disabled:cursor-not-allowed"
//         >
//           {isLoading ? 'Optimizing...' : 'Optimize Models'}
//         </button>

//         <button
//           onClick={loadOptimizedModels}
//           disabled={isLoading}
//           className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 
//                    disabled:bg-green-300 disabled:cursor-not-allowed"
//         >
//           {isLoading ? 'Loading...' : 'Load Optimized Models'}
//         </button>
//       </div>

//       {status && (
//         <div className="text-sm text-gray-600">
//           {status}
//         </div>
//       )}

//       {stats && (
//         <div className="space-y-2">
//           <div className="font-semibold">Optimization Results:</div>
//           <div>Original Size: {stats.originalSize}</div>
//           <div>Optimized Size: {stats.optimizedSize}</div>
//           <div>Size Reduction: {stats.reduction}%</div>
//           <div>Models Processed: {stats.modelCount}</div>
//         </div>
//       )}
//     </div>
//   );
// };

// export default OptimizedModelLoader;