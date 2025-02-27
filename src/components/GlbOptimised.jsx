import React, { useCallback, useState, useEffect, useRef } from "react";
import * as BABYLON from "@babylonjs/core";
import "@babylonjs/loaders";
import { calculateScreenCoverage } from "../utils/CalculateScreenCoverage";
import { loadModels } from "../utils/LoadModels";
import {createOctreeBlock,createOctreeInfo,distributeMeshesToOctree} from "../utils/CreateOctreeBlock";

// Optimized configuration
const NUM_WORKERS = Math.max(navigator.hardwareConcurrency || 4, 8);
const BATCH_SIZE = 10;
const DB_BATCH_SIZE = 50;
const MESH_CHUNK_SIZE = 1000;

function OptimizedGlbSelect() {
  const [files, setFiles] = useState([]);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const engineRef = useRef(null);
  const sceneRef = useRef(null);
  const canvasRef = useRef(null);
  const workersRef = useRef([]);
  const workerQueueRef = useRef([]);
  const meshIdCounter = useRef(1);
  const dbConnection = useRef(null);

  const [processProgress, setProcessProgress] = useState({
    stage: "",
    current: 0,
    total: 0,
    subStage: "",
    subProgress: 0,
    processingStage: 0,
  });
  const processingTasksRef = useRef({
    totalTasks: 0,
    completedTasks: 0,
    pending: new Set(),
  });

  // Optimized IndexedDB initialization with connection pooling
  const initDB = useCallback(async () => {
    if (dbConnection.current) return dbConnection.current;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open("huldrascreencoverage1", 1);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        dbConnection.current = request.result;
        resolve(request.result);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        const storeNames = [
          "octree",
          "lowPolyMeshes",
          "originalMeshes",
          "mergedlowPoly",
          "mergedSkippedMeshes",
        ];

        storeNames.forEach((storeName) => {
          if (!db.objectStoreNames.contains(storeName)) {
            db.createObjectStore(storeName);
          }
        });
      };
    });
  }, []);

  // Optimized batch storage
  const batchStoreInDB = async (operations) => {
    const db = await initDB();
    const stores = new Map();

    // Group operations by store
    operations.forEach((op) => {
      if (!stores.has(op.store)) {
        stores.set(op.store, []);
      }
      stores.get(op.store).push(op);
    });

    // Process each store in parallel
    await Promise.all(
      Array.from(stores.entries()).map(([storeName, ops]) => {
        const transaction = db.transaction(storeName, "readwrite");
        const store = transaction.objectStore(storeName);

        return Promise.all(
          ops.map(
            (op) =>
              new Promise((resolve, reject) => {
                const request = store.put(op.data, op.key);
                request.onsuccess = resolve;
                request.onerror = reject;
              })
          )
        );
      })
    );
  };

  // Optimized file loading
  const loadFile = async (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = async (event) => {
        try {
          const scene = sceneRef.current;
          const data = event.target.result;

          const result = await BABYLON.SceneLoader.LoadAssetContainerAsync(
            "file:",
            file,
            scene,
            null,
            ".glb"
          );

          resolve(result);
        } catch (error) {
          reject(error);
        }
      };

      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  };

  // Initialize optimized worker pool
  useEffect(() => {
    workersRef.current = Array(NUM_WORKERS)
      .fill(null)
      .map(() => {
        const worker = new Worker(new URL("./meshWorker.js", import.meta.url));
        worker.busy = false;

        worker.onmessage = async (e) => {
          try {
            const { type, meshId, originalMeshId, data, error, skipped } =
              e.data;

            if (type === "success") {
              const dataToStore = {
                fileName: meshId,
                data: {
                  fileName: meshId,
                  positions: data.data.positions,
                  normals: data.data.normals,
                  indices: data.data.indices,
                  boundingBox: data.data.boundingBox,
                  name: data.data.name,
                  metadata: {
                    id: meshId,
                    originalMeshId,
                    ...(data.data.metadata || {}),
                    processedSuccessfully: true,
                  },
                  transforms: data.data.transforms || {},
                },
              };

              // Store both original and simplified mesh data
              await batchStoreInDB([
                {
                  store: "lowPolyMeshes",
                  key: meshId,
                  data: dataToStore,
                },
              ]);

              // Track completion
              processingTasksRef.current.completedTasks++;
              processingTasksRef.current.pending.delete(meshId);

              setProgress((prev) => ({
                ...prev,
                current: processingTasksRef.current.completedTasks,
                total: processingTasksRef.current.totalTasks,
              }));
            } else if (type === "error") {
              console.error(`Error processing mesh ${meshId}:`, error);
              // Store error information for tracking
              await batchStoreInDB([
                {
                  store: "lowPolyMeshes",
                  key: meshId,
                  data: {
                    fileName: meshId,
                    error: error,
                    metadata: {
                      id: meshId,
                      originalMeshId,
                      processedSuccessfully: false,
                      errorMessage: error,
                    },
                  },
                },
              ]);
              processingTasksRef.current.completedTasks++;
              processingTasksRef.current.pending.delete(meshId);
            }
          } catch (processError) {
            console.error("Error in worker message processing:", processError);
          } finally {
            worker.busy = false;
            if (workerQueueRef.current.length > 0) {
              const nextTask = workerQueueRef.current.shift();
              worker.busy = true;
              worker.postMessage(nextTask);
            }
          }
        };

        return worker;
      });

    return () => workersRef.current.forEach((worker) => worker.terminate());
  }, []);

  const waitForTasksCompletion = async () => {
    return new Promise((resolve) => {
      const checkCompletion = () => {
        if (
          processingTasksRef.current.pending.size === 0 &&
          processingTasksRef.current.completedTasks ===
            processingTasksRef.current.totalTasks
        ) {
          resolve();
        } else {
          setTimeout(checkCompletion, 100);
        }
      };
      checkCompletion();
    });
  };

  // Optimized mesh processing
  const processMesh = async (mesh, fileId) => {
    if (!mesh.geometry) return null;

    const meshId = meshIdCounter.current++;
    const originalMeshId = `ori${String(meshId).padStart(7, "0")}`;
    const lowPolyMeshId = `lpolyori${String(meshId).padStart(7, "0")}`;

    const screenCoverage = calculateScreenCoverage(
      mesh,
      sceneRef.current.activeCamera,
      engineRef.current
    );

    // Process mesh data in parallel
    const [positions, normals, indices] = await Promise.all([
      mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind),
      mesh.getVerticesData(BABYLON.VertexBuffer.NormalKind),
      mesh.getIndices(),
    ]);

    const meshData = {
      fileName: originalMeshId,
      data: {
        fileName: originalMeshId,
        positions: Array.from(positions),
        normals: Array.from(normals),
        indices: Array.from(indices),
        boundingBox: mesh.getBoundingInfo().boundingBox,
        name: mesh.name,
        metadata: {
          id: originalMeshId,
          fileId,
          screenCoverage,
          geometryInfo: {
            totalVertices: mesh.getTotalVertices(),
            totalIndices: mesh.getTotalIndices(),
            faceCount: mesh.getTotalIndices() / 3,
          },
        },
        transforms: {
          position: mesh.position.asArray(),
          rotation: mesh.rotation.asArray(),
          scaling: mesh.scaling.asArray(),
          worldMatrix: mesh.getWorldMatrix().toArray(),
        },
      },
    };

    // Return processing results
    return {
      meshInfo: {
        metadata: {
          id: originalMeshId,
          fileId,
          screenCoverage,
        },
        boundingInfo: mesh.getBoundingInfo(),
        transforms: {
          worldMatrix: mesh.getWorldMatrix().toArray(),
        },
      },
      meshData,
      workerTask: {
        meshData: meshData.data,
        meshId: lowPolyMeshId,
        originalMeshId,
      },
    };
  };
  const validateFile = (file) => {
    if (!file.name.toLowerCase().endsWith(".glb")) {
      throw new Error("Invalid file type. Only GLB files are supported.");
    }
    if (file.size === 0) {
      throw new Error("File is empty.");
    }
    if (file.size > 2 * 1024 * 1024 * 1024) {
      // 2GB limit
      throw new Error("File is too large.");
    }
  };

  const processFile = async (file) => {
    validateFile(file);
    const container = await loadFile(file);
    const fileId = file.name.replace(/[^a-zA-Z0-9]/g, "_");
    const meshPromises = [];
    const dbOperations = [];
    const workerTasks = [];

    try {
      // Process meshes in parallel
      for (const mesh of container.meshes) {
        if (!mesh.geometry) continue;
        meshPromises.push(processMesh(mesh, fileId));
      }

      const results = (await Promise.all(meshPromises)).filter(Boolean);

      results.forEach(({ meshInfo, meshData, workerTask }) => {
        dbOperations.push({
          store: "originalMeshes",
          key: meshData.fileName,
          data: meshData,
        });
        workerTasks.push(workerTask);

        // Track new task
        processingTasksRef.current.totalTasks++;
        processingTasksRef.current.pending.add(workerTask.meshId);
      });

      await batchStoreInDB(dbOperations);

      // Distribute worker tasks
      workerTasks.forEach((task) => {
        const availableWorker = workersRef.current.find((w) => !w.busy);
        if (availableWorker) {
          availableWorker.busy = true;
          availableWorker.postMessage(task);
        } else {
          workerQueueRef.current.push(task);
        }
      });
      

      return results.map((r) => r.meshInfo);
    } catch (error) {
      console.error(`Error processing file ${fileId}:`, error);
      throw error;
    } finally {
      container.dispose();
    }
  };

  // Optimized file change handler
  const handleFileChange = useCallback(async (event) => {
    const selectedFiles = Array.from(event.target.files);
    setFiles(selectedFiles);
  
    try {
      // Reset task tracking
      processingTasksRef.current = {
        totalTasks: 0,
        completedTasks: 0,
        pending: new Set(),
      };
  
      let allMeshInfos = [];
      updateProgress({
        stage: "Processing Files",
        current: 0,
        total: selectedFiles.length,
        processingStage: 1,
        subStage: "Initializing",
        subProgress: 0,
      });
  
      // Process files in batches
      for (let i = 0; i < selectedFiles.length; i += BATCH_SIZE) {
        const batch = selectedFiles.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(batch.map((file) => processFile(file)));
        allMeshInfos = allMeshInfos.concat(batchResults.flat());
  
        // Update progress percentage based on the files processed
        const progress = Math.min(
          Math.floor(((i + BATCH_SIZE) / selectedFiles.length) * 100),
          100
        );
        updateProgress({
          stage: "Processing Files",
          processingStage: 1,
          subStage: `Processing batch ${i / BATCH_SIZE + 1}`,
          subProgress: progress,
        });
      }
  
      // Wait for all simplification tasks to complete
      updateProgress({
        stage: "Simplifying Meshes",
        processingStage: 2,
        subStage: "Waiting for mesh processing to complete",
        subProgress: 0,
      });
  
      await waitForTasksCompletion();
  
      updateProgress({
        stage: "Simplifying Meshes",
        processingStage: 2,
        subStage: "Simplification complete",
        subProgress: 100,
      });
  
      // Store all original meshes
      updateProgress({
        stage: "Storing Meshes",
        processingStage: 3,
        subStage: "Saving meshes to database",
        subProgress: 0,
      });
  
      await batchStoreInDB([
        {
          store: "originalMeshes",
          key: "meshData",
          data: allMeshInfos,
        },
      ]);
  
      updateProgress({
        stage: "Storing Meshes",
        processingStage: 3,
        subStage: "Meshes stored successfully",
        subProgress: 100,
      });
  
      // Now create and store octree
      updateProgress({
        stage: "Creating Octree",
        processingStage: 4,
        subStage: "Building octree structure",
        subProgress: 0,
      });
  
      const octreeRoot = createOctreeBlock(
        sceneRef.current,
        getMinBounds(allMeshInfos),
        getMaxBounds(allMeshInfos),
        allMeshInfos,
        0,
        null
      );
  
      const octreeInfo = createOctreeInfo(
        octreeRoot,
        getMinBounds(allMeshInfos),
        getMaxBounds(allMeshInfos)
      );
  
      await batchStoreInDB([
        {
          store: "octree",
          key: "mainOctree",
          data: octreeInfo,
        },
      ]);
  
      updateProgress({
        stage: "Creating Octree",
        processingStage: 4,
        subStage: "Octree created successfully",
        subProgress: 100,
      });
  
      // Load models
      updateProgress({
        stage: "Loading Models",
        processingStage: 5,
        subStage: "Processing models",
        subProgress: 0,
      });
  
      await loadModels();
  
      updateProgress({
        stage: "Complete",
        processingStage: 6,
        subStage: "Processing complete",
        subProgress: 100,
      });
    } catch (error) {
      console.error("Error:", error);
      setStatus("Error: " + error.message);
      updateProgress({
        stage: "Error",
        subStage: error.message,
        subProgress: 0,
      });
    }
  }, []);
  

  // Helper functions
  const getMinBounds = (meshInfos) => {
    return meshInfos.reduce((min, info) => {
      const bounds = info.boundingInfo.boundingBox.minimumWorld;
      return new BABYLON.Vector3(
        Math.min(min.x, bounds.x),
        Math.min(min.y, bounds.y),
        Math.min(min.z, bounds.z)
      );
    }, new BABYLON.Vector3(Infinity, Infinity, Infinity));
  };

  const getMaxBounds = (meshInfos) => {
    return meshInfos.reduce((max, info) => {
      const bounds = info.boundingInfo.boundingBox.maximumWorld;
      return new BABYLON.Vector3(
        Math.max(max.x, bounds.x),
        Math.max(max.y, bounds.y),
        Math.max(max.z, bounds.z)
      );
    }, new BABYLON.Vector3(-Infinity, -Infinity, -Infinity));
  };

  const updateProgress = (updates) => {
    setProcessProgress((prev) => ({
      ...prev,
      ...updates,
    }));
  };

  const calculateOverallProgress = () => {
    const { processingStage, current, total } = processProgress;
    const stageWeight = 25;
    const baseProgress = processingStage * stageWeight;

    if (total === 0) return baseProgress;
    const stageProgress = (current / total) * stageWeight;
    return Math.min(baseProgress + stageProgress, 100);
  };

  // Initialize 3D scene
  useEffect(() => {
    const canvas = document.createElement("canvas");
    canvas.style.display = "none";
    document.body.appendChild(canvas);
    canvasRef.current = canvas;

    const engine = new BABYLON.Engine(canvas, true, {
      preserveDrawingBuffer: true,
      stencil: true,
    });
    engineRef.current = engine;

    const scene = new BABYLON.Scene(engine);
    sceneRef.current = scene;

    const camera = new BABYLON.ArcRotateCamera(
      "camera",
      0,
      Math.PI / 3,
      10,
      BABYLON.Vector3.Zero(),
      scene
    );
    camera.attachControl(canvas, true);

    // Optimize camera settings
    camera.radius = 100;
    camera.alpha = Math.PI / 4;
    camera.beta = Math.PI / 3;
    camera.wheelPrecision = 50;
    camera.minZ = 0.1;
    camera.maxZ = 1000;

    scene.activeCamera = camera;

    const light = new BABYLON.HemisphericLight(
      "light",
      new BABYLON.Vector3(0, 1, 0),
      scene
    );

    // Optimize rendering
    engine.setHardwareScalingLevel(1);
    scene.clearColor = new BABYLON.Color4(0, 0, 0, 0);
    scene.autoClear = false;
    scene.autoClearDepthAndStencil = false;

    engine.runRenderLoop(() => scene.render());

    const handleResize = () => engine.resize();
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      engine.dispose();
      scene.dispose();
      canvas.remove();
    };
  }, []);
  const handleloadModels=async()=>{
    await loadModels();
  }

  return (
    <div className="p-4" style={{ position: "absolute", zIndex: "1000" }}>
      <input
        type="file"
        accept=".glb"
        multiple
        onChange={handleFileChange}
        className="mb-4 block w-full text-sm text-gray-500
          file:mr-4 file:py-2 file:px-4
          file:rounded-md file:border-0
          file:text-sm file:font-semibold
          file:bg-blue-50 file:text-blue-700
          hover:file:bg-blue-100"
      />
        <button onClick={handleloadModels}>loadmodels</button>


      {status && <div className="mt-2 text-sm text-gray-600">{status}</div>}

      {processProgress.processingStage > 0 && (
        <div className="mt-4 space-y-2">
          {/* Overall Progress */}
          <div className="flex justify-between text-sm text-gray-600">
            <span>{processProgress.stage}</span>
            <span>{Math.round(calculateOverallProgress())}%</span>
          </div>

          {/* Main Progress Bar */}
          <div className="w-full bg-gray-200 rounded-full h-2.5 mb-4">
            <div
              className="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
              style={{ width: `${calculateOverallProgress()}%` }}
            />
          </div>

          {/* Sub-progress Section */}
          {processProgress.subStage && (
            <div className="text-sm text-gray-500">
              <div className="flex justify-between">
                <span>{processProgress.subStage}</span>
                <span>{Math.round(processProgress.subProgress)}%</span>
              </div>
              <div className="w-full bg-gray-100 rounded-full h-1.5 mt-1">
                <div
                  className="bg-blue-400 h-1.5 rounded-full transition-all duration-300"
                  style={{ width: `${processProgress.subProgress}%` }}
                />
              </div>
            </div>
          )}

          {/* Statistics Display */}
          {processProgress.processingStage === 4 && (
            <div className="mt-4 p-4 bg-gray-50 rounded-lg">
              <h3 className="text-sm font-medium text-gray-700">
                Processing Statistics
              </h3>
              <div className="mt-2 grid grid-cols-2 gap-4 text-sm text-gray-600">
                <div>
                  <span className="font-medium">Total Files:</span>{" "}
                  {files.length}
                </div>
                <div>
                  <span className="font-medium">Processing Time:</span>
                  {` ${(
                    (Date.now() - processProgress.startTime) /
                    1000
                  ).toFixed(1)}s`}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Error Display */}
      {processProgress.stage === "Error" && (
        <div className="mt-4 p-4 bg-red-50 rounded-lg">
          <div className="flex">
            <div className="flex-shrink-0">
              <svg
                className="h-5 w-5 text-red-400"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800">
                Processing Error
              </h3>
              <div className="mt-2 text-sm text-red-700">
                {processProgress.subStage}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default OptimizedGlbSelect;

