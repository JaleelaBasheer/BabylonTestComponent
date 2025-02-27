import * as BABYLON from "@babylonjs/core";

export  const FreeCameraMouseInput = function() {
    this.buttons = [];
    this.angularSensibility = 2000.0;
    this.offsetX = 0;
    this.offsetY = 0;
    this.direction = new BABYLON.Vector3(0, 0, 0);
}

FreeCameraMouseInput.prototype.attachControl = function(element, noPreventDefault) {
    var _this = this;
    if(!this._pointerInput) {
        this._pointerInput = function(p, s) {
            var evt = p.event;
            if(evt.pointerType != 'mouse') return;
            if(p.type == BABYLON.PointerEventTypes.POINTERDOWN) {
                try {
                    evt.srcElement.setPointerCapture(evt.pointerId);
                }
                catch(e) {}
                if(_this.buttons.length == 0) _this.buttons.push(evt.button);
                _this.previousPosition = {
                    x: evt.clientX,
                    y: evt.clientY
                };
                if(!noPreventDefault) {
                    evt.preventDefault();
                }
            }
            else if(p.type == BABYLON.PointerEventTypes.POINTERUP) {
                try {
                    evt.srcElement.releasePointerCapture(evt.pointerId);
                }
                catch(e) {}
                if(_this.buttons.length != 0) _this.buttons.pop();
                _this.previousPosition = null;
                _this.offsetX = 0;
                _this.offsetY = 0;
                if(!noPreventDefault) evt.preventDefault();
            }
            else if(p.type == BABYLON.PointerEventTypes.POINTERMOVE) {
                if(!_this.previousPosition) return;
                _this.offsetX = evt.clientX - _this.previousPosition.x;
                _this.offsetY = evt.clientY - _this.previousPosition.y;
                if(!noPreventDefault) evt.preventDefault();
            }
        };
    }
    this._observer = this.camera.getScene().onPointerObservable.add(this._pointerInput, 
        BABYLON.PointerEventTypes.POINTERDOWN | BABYLON.PointerEventTypes.POINTERUP | BABYLON.PointerEventTypes.POINTERMOVE);
}

FreeCameraMouseInput.prototype.detachControl = function(element) {
    if(this._observer && element) {
        this.camera.getScene().onPointerObservable.remove(this._observer);
        this._observer = null;
        this.previousPosition = null;
    }
}

FreeCameraMouseInput.prototype.checkInputs = function() {
    var speed = this.camera.speed;
    if(!this.previousPosition) return;
    if(this.buttons.indexOf(0) != -1) {
        if(this.camera.getScene().useRightHandedSystem) this.camera.cameraRotation.y -= this.offsetX / (20 * this.angularSensibility);
        else this.camera.cameraRotation.y += this.offsetX / (20 * this.angularSensibility);
        this.direction.copyFromFloats(0, 0, -this.offsetY * speed / 300);
        if(this.camera.getScene().useRightHandedSystem) this.direction.z *= -1;
    }
    if(this.buttons.indexOf(1) != -1) this.direction.copyFromFloats(this.offsetX * speed / 500, -this.offsetY * speed / 500, 0);
    if(this.buttons.indexOf(0) != -1 || this.buttons.indexOf(1) != -1) {
        this.camera.getViewMatrix().invertToRef(this.camera._cameraTransformMatrix);
        BABYLON.Vector3.TransformNormalToRef(this.direction, this.camera._cameraTransformMatrix, this.camera._transformedDirection);
        this.camera.cameraDirection.addInPlace(this.camera._transformedDirection);
    }
}

FreeCameraMouseInput.prototype.getTypeName = function() {
    return "FreeCameraMouseInput";
}

FreeCameraMouseInput.prototype.getSimpleName = function() {
    return "mouse";
}