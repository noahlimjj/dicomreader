import {describe, it, expect} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {parse, extractMeta} from '../src/engine/meta.js';
import {makeItems, groupSeries, anatomicalNormal} from '../src/model/study.js';
import {planeOf, nearestSlice, pixelToPatient, intersection, sameSpace} from '../src/model/geometry.js';

describe('anatomical ordering and scout localizer', () => {
  it('computes correct anatomical normal vectors', () => {
    // Axial: row=[1,0,0], col=[0,1,0] -> normal=[0,0,1] -> anatomical=[0,0,-1] (superior to inferior)
    const axialItem = {hasGeometry: true, iop: [1, 0, 0, 0, 1, 0], ipp: [0, 0, 100]};
    const axN = anatomicalNormal(axialItem);
    expect(axN[0]).toBeCloseTo(0);
    expect(axN[1]).toBeCloseTo(0);
    expect(axN[2]).toBeCloseTo(-1);

    // Coronal: row=[1,0,0], col=[0,0,-1] -> normal=[0,1,0] -> anatomical=[0,1,0] (anterior to posterior)
    const coronalItem = {hasGeometry: true, iop: [1, 0, 0, 0, 0, -1], ipp: [0, -50, 0]};
    const corN = anatomicalNormal(coronalItem);
    expect(corN[0]).toBeCloseTo(0);
    expect(corN[1]).toBeCloseTo(1);
    expect(corN[2]).toBeCloseTo(0);

    // Sagittal: row=[0,1,0], col=[0,0,-1] -> normal=[-1,0,0] -> anatomical=[1,0,0] (right to left)
    const sagittalItem = {hasGeometry: true, iop: [0, 1, 0, 0, 0, -1], ipp: [-50, 0, 0]};
    const sagN = anatomicalNormal(sagittalItem);
    expect(sagN[0]).toBeCloseTo(1);
    expect(sagN[1]).toBeCloseTo(0);
    expect(sagN[2]).toBeCloseTo(0);
  });

  it('orders axial series Cranial to Caudal even when acquired Caudocranial (feet first)', () => {
    const dir = './test/library/ct_chest';
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.dcm'));
    const items = [];
    for (const f of files) {
      const buf = fs.readFileSync(path.join(dir, f));
      const dataSet = parse(buf, {untilPixelData: true});
      const meta = extractMeta(dataSet);
      const entry = {key: f, name: f, size: buf.length};
      items.push(...makeItems(entry, meta));
    }
    const seriesList = groupSeries(items);
    const ct = seriesList[0];
    expect(ct.items.length).toBe(199);

    // Slice 0 must be cranial (Z closer to 0 / higher)
    // Slice last must be caudal (Z more negative / lower)
    const firstZ = ct.items[0].ipp[2];
    const lastZ = ct.items[ct.items.length - 1].ipp[2];
    expect(firstZ).toBeGreaterThan(lastZ);
    expect(firstZ).toBeCloseTo(-10.06, 1);
    expect(lastZ).toBeCloseTo(-208.06, 1);
  });

  it('orders public/samples axial series Cranial to Caudal', () => {
    const dir = './public/samples';
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.dcm'));
    const items = [];
    for (const f of files) {
      const buf = fs.readFileSync(path.join(dir, f));
      const dataSet = parse(buf, {untilPixelData: true});
      const meta = extractMeta(dataSet);
      const entry = {key: f, name: f, size: buf.length};
      items.push(...makeItems(entry, meta));
    }
    const seriesList = groupSeries(items);
    const axial = seriesList.find(s => s.title.includes('Axial'));
    expect(axial).toBeDefined();

    const firstZ = axial.items[0].ipp[2];
    const lastZ = axial.items[axial.items.length - 1].ipp[2];
    expect(firstZ).toBeGreaterThan(lastZ);
    expect(firstZ).toBeCloseTo(93.75, 1);
    expect(lastZ).toBeCloseTo(-93.75, 1);
  });

  it('clamps nearestSlice cleanly when clicking outside the volume boundary', () => {
    const dir = './public/samples';
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.dcm'));
    const items = [];
    for (const f of files) {
      const buf = fs.readFileSync(path.join(dir, f));
      const dataSet = parse(buf, {untilPixelData: true});
      const meta = extractMeta(dataSet);
      const entry = {key: f, name: f, size: buf.length};
      items.push(...makeItems(entry, meta));
    }
    const seriesList = groupSeries(items);
    const axial = seriesList.find(s => s.title.includes('Axial'));

    // Point far above the volume (Z = 200, volume is Z in [-93.75, 93.75])
    const ptAbove = [0, 0, 200];
    expect(nearestSlice(axial, ptAbove, {clamp: false})).toBe(-1);
    expect(nearestSlice(axial, ptAbove, {clamp: true})).toBe(0);

    // Point far below the volume (Z = -200)
    const ptBelow = [0, 0, -200];
    expect(nearestSlice(axial, ptBelow, {clamp: false})).toBe(-1);
    expect(nearestSlice(axial, ptBelow, {clamp: true})).toBe(axial.items.length - 1);
  });

  it('scout localizer moves reference line from top to bottom as user scrolls forward', () => {
    const dir = './public/samples';
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.dcm'));
    const items = [];
    for (const f of files) {
      const buf = fs.readFileSync(path.join(dir, f));
      const dataSet = parse(buf, {untilPixelData: true});
      const meta = extractMeta(dataSet);
      const entry = {key: f, name: f, size: buf.length};
      items.push(...makeItems(entry, meta));
    }
    const seriesList = groupSeries(items);
    const scout = seriesList.find(s => s.title.includes('Scout'));
    const axial = seriesList.find(s => s.title.includes('Axial'));

    const scoutPlane = planeOf(scout.items[0]);
    const firstAxialPlane = planeOf(axial.items[0]);
    const lastAxialPlane = planeOf(axial.items[axial.items.length - 1]);

    const segFirst = intersection(scoutPlane, firstAxialPlane);
    const segLast = intersection(scoutPlane, lastAxialPlane);

    expect(segFirst).not.toBeNull();
    expect(segLast).not.toBeNull();

    // In scout image, row/y increases downwards from top (head) to bottom (feet).
    // The first axial slice (head) must have a smaller y coordinate on the scout than the last slice (feet).
    const yFirst = (segFirst[0][1] + segFirst[1][1]) / 2;
    const yLast = (segLast[0][1] + segLast[1][1]) / 2;

    expect(yFirst).toBeLessThan(yLast);
  });
});
