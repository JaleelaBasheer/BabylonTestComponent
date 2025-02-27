// src/utils/cameraUtils.js
import * as BABYLON from "@babylonjs/core";
export const fitCameraToOctree = (camera, maximum, minimum) => {
    const maxVector = (maximum instanceof BABYLON.Vector3)
        ? maximum
        : new BABYLON.Vector3(maximum.x, maximum.y, maximum.z);

    const minVector = (minimum instanceof BABYLON.Vector3)
        ? minimum
        : new BABYLON.Vector3(minimum.x, minimum.y, minimum.z);

    const center = BABYLON.Vector3.Center(minVector, maxVector);
    const size = maxVector.subtract(minVector);
    const maxDimension = Math.max(size.x, size.y, size.z);

    camera.setTarget(center);

    const fovRadians = camera.fov || (Math.PI / 4);
    const distanceToFit = maxDimension / (2 * Math.tan(fovRadians / 2));

    camera.radius = distanceToFit * 1.2;
    camera.alpha = Math.PI / 4;
    camera.beta = Math.PI / 3;

    camera.wheelPrecision = 50;
    camera.minZ = maxDimension * 0.01;
    camera.maxZ = maxDimension * 1000;

    const distanceThreshold =distanceToFit;
    console.log(distanceThreshold)
    
    return distanceThreshold

};





