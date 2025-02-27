  // Modified cleanupMesh with more aggressive disposal
  export const cleanupMesh = async (mesh,scene) => {
    return new Promise((resolve) => {
      try {
        if (!mesh || mesh.isDisposed()) {
          resolve();
          return;
        }
        // Immediate disable
        mesh.setEnabled(false);
        mesh.isVisible = false;

        // Force immediate material disposal
        if (mesh.material) {
          mesh.material.dispose(true, true);
        }

        // Remove from scene immediately
        const sceneIndex = scene.meshes.indexOf(mesh);
        if (sceneIndex > -1) {
            scene.meshes.splice(sceneIndex, 1);
        }

        // Final disposal
        mesh.dispose(false, true);

        // Verify disposal
        if (!mesh.isDisposed()) {
          console.warn(
            "Mesh not disposed after first attempt, forcing disposal"
          );
          mesh.dispose(true, true); // More aggressive disposal
        }

        resolve();
      } catch (error) {
        console.error("Error in cleanupMesh:", error);
        resolve(); // Resolve anyway to prevent hanging
      }
    });
  };