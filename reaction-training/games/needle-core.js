(function attachNeedleCore(root, factory) {
  const core = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = core;
  }

  if (root) {
    root.NeedleCore = core;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createNeedleCore() {
  const FULL_CIRCLE = Math.PI * 2;
  const LAST_ANGLE_BEFORE_FULL_CIRCLE = FULL_CIRCLE - Number.EPSILON * 4;

  function normaliseAngle(angle) {
    const numericAngle = Number(angle);

    if (!Number.isFinite(numericAngle)) {
      return 0;
    }

    const remainder = numericAngle % FULL_CIRCLE;

    if (remainder === 0) {
      return 0;
    }

    if (remainder > 0) {
      return remainder;
    }

    const normalised = FULL_CIRCLE + remainder;
    return normalised < FULL_CIRCLE ? normalised : LAST_ANGLE_BEFORE_FULL_CIRCLE;
  }

  function isCollision(angle, placedAngles, clearance) {
    const numericAngle = Number(angle);
    const numericClearance = Number(clearance);

    if (!Array.isArray(placedAngles) || !Number.isFinite(numericAngle) || !Number.isFinite(numericClearance) || numericClearance < 0) {
      return false;
    }

    const target = normaliseAngle(numericAngle);

    return placedAngles.some((placedAngle) => {
      if (!Number.isFinite(Number(placedAngle))) {
        return false;
      }

      const difference = Math.abs(target - normaliseAngle(placedAngle));
      return Math.min(difference, FULL_CIRCLE - difference) <= numericClearance;
    });
  }

  function distanceSquared(first, second) {
    const dx = first.x - second.x;
    const dy = first.y - second.y;
    return dx * dx + dy * dy;
  }

  function pointToSegmentDistanceSquared(point, start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;

    if (lengthSquared === 0) {
      return distanceSquared(point, start);
    }

    const projection = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
    return distanceSquared(point, {
      x: start.x + projection * dx,
      y: start.y + projection * dy,
    });
  }

  function orientation(first, second, third) {
    return (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
  }

  function segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
    const firstOrientation = orientation(firstStart, firstEnd, secondStart);
    const secondOrientation = orientation(firstStart, firstEnd, secondEnd);
    const thirdOrientation = orientation(secondStart, secondEnd, firstStart);
    const fourthOrientation = orientation(secondStart, secondEnd, firstEnd);
    const epsilon = Number.EPSILON * 100;

    return ((firstOrientation > epsilon && secondOrientation < -epsilon) || (firstOrientation < -epsilon && secondOrientation > epsilon))
      && ((thirdOrientation > epsilon && fourthOrientation < -epsilon) || (thirdOrientation < -epsilon && fourthOrientation > epsilon));
  }

  function segmentDistanceSquared(firstStart, firstEnd, secondStart, secondEnd) {
    if (segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd)) {
      return 0;
    }

    return Math.min(
      pointToSegmentDistanceSquared(firstStart, secondStart, secondEnd),
      pointToSegmentDistanceSquared(firstEnd, secondStart, secondEnd),
      pointToSegmentDistanceSquared(secondStart, firstStart, firstEnd),
      pointToSegmentDistanceSquared(secondEnd, firstStart, firstEnd),
    );
  }

  function createNeedleShape(angle, geometry) {
    const direction = { x: Math.cos(angle), y: Math.sin(angle) };
    const start = { x: direction.x * geometry.radius, y: direction.y * geometry.radius };
    const tip = {
      x: direction.x * (geometry.radius + geometry.needleLength),
      y: direction.y * (geometry.radius + geometry.needleLength),
    };

    return { start, tip };
  }

  function shapesContact(first, second, geometry) {
    const halfStroke = geometry.strokeWidth / 2;
    const lineDistance = segmentDistanceSquared(first.start, first.tip, second.start, second.tip);
    const firstTipToSecondLine = pointToSegmentDistanceSquared(first.tip, second.start, second.tip);
    const secondTipToFirstLine = pointToSegmentDistanceSquared(second.tip, first.start, first.tip);
    const tipDistance = distanceSquared(first.tip, second.tip);

    return lineDistance <= geometry.strokeWidth * geometry.strokeWidth
      || firstTipToSecondLine <= (geometry.tipRadius + halfStroke) ** 2
      || secondTipToFirstLine <= (geometry.tipRadius + halfStroke) ** 2
      || tipDistance <= (geometry.tipRadius * 2) ** 2;
  }

  function isNeedleContact(angle, placedAngles, geometry) {
    if (!Array.isArray(placedAngles) || !geometry || !Number.isFinite(Number(angle))) {
      return false;
    }

    const values = ['radius', 'needleLength', 'strokeWidth', 'tipRadius'];
    if (values.some((key) => !Number.isFinite(Number(geometry[key])) || Number(geometry[key]) <= 0)) {
      return false;
    }

    const target = createNeedleShape(Number(angle), geometry);
    return placedAngles.some((placedAngle) => Number.isFinite(Number(placedAngle))
      && shapesContact(target, createNeedleShape(Number(placedAngle), geometry), geometry));
  }

  function nextSpeed(speed, placedCount) {
    // Each placed needle adds a noticeable acceleration on top of the base step.
    if (Number(placedCount) > 8) {
      return +Number(speed).toFixed(2);
    }

    return +(speed + 0.08 + placedCount * 0.06).toFixed(2);
  }

  return { isCollision, isNeedleContact, nextSpeed, normaliseAngle };
}));
