/** @format */

import {
  getEnvironment,
  isProductionLike,
  isProduction,
  isDevelopment,
  isTest,
} from './environment';

describe('environment utilities', () => {
  const originalNodeEnv = process.env['NODE_ENV'];

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = originalNodeEnv;
    }
  });

  describe('getEnvironment', () => {
    it('should return "development" for development environment', () => {
      process.env['NODE_ENV'] = 'development';
      expect(getEnvironment()).toBe('development');
    });

    it('should return "staging" for staging environment', () => {
      process.env['NODE_ENV'] = 'staging';
      expect(getEnvironment()).toBe('staging');
    });

    it('should return "production" for production environment', () => {
      process.env['NODE_ENV'] = 'production';
      expect(getEnvironment()).toBe('production');
    });

    it('should return "test" for test environment', () => {
      process.env['NODE_ENV'] = 'test';
      expect(getEnvironment()).toBe('test');
    });

    it('should return "development" for undefined NODE_ENV', () => {
      delete process.env['NODE_ENV'];
      expect(getEnvironment()).toBe('development');
    });

    it('should return "development" for unexpected NODE_ENV values', () => {
      process.env['NODE_ENV'] = 'unknown';
      expect(getEnvironment()).toBe('development');
    });
  });

  describe('isProductionLike', () => {
    it('should return true for production environment', () => {
      process.env['NODE_ENV'] = 'production';
      expect(isProductionLike()).toBe(true);
    });

    it('should return true for staging environment', () => {
      process.env['NODE_ENV'] = 'staging';
      expect(isProductionLike()).toBe(true);
    });

    it('should return false for development environment', () => {
      process.env['NODE_ENV'] = 'development';
      expect(isProductionLike()).toBe(false);
    });

    it('should return false for test environment', () => {
      process.env['NODE_ENV'] = 'test';
      expect(isProductionLike()).toBe(false);
    });

    it('should return false for undefined NODE_ENV', () => {
      delete process.env['NODE_ENV'];
      expect(isProductionLike()).toBe(false);
    });
  });

  describe('isProduction', () => {
    it('should return true only for production environment', () => {
      process.env['NODE_ENV'] = 'production';
      expect(isProduction()).toBe(true);
    });

    it('should return false for staging environment', () => {
      process.env['NODE_ENV'] = 'staging';
      expect(isProduction()).toBe(false);
    });

    it('should return false for development environment', () => {
      process.env['NODE_ENV'] = 'development';
      expect(isProduction()).toBe(false);
    });

    it('should return false for test environment', () => {
      process.env['NODE_ENV'] = 'test';
      expect(isProduction()).toBe(false);
    });
  });

  describe('isDevelopment', () => {
    it('should return true only for development environment', () => {
      process.env['NODE_ENV'] = 'development';
      expect(isDevelopment()).toBe(true);
    });

    it('should return false for staging environment', () => {
      process.env['NODE_ENV'] = 'staging';
      expect(isDevelopment()).toBe(false);
    });

    it('should return false for production environment', () => {
      process.env['NODE_ENV'] = 'production';
      expect(isDevelopment()).toBe(false);
    });

    it('should return false for test environment', () => {
      process.env['NODE_ENV'] = 'test';
      expect(isDevelopment()).toBe(false);
    });
  });

  describe('isTest', () => {
    it('should return true only for test environment', () => {
      process.env['NODE_ENV'] = 'test';
      expect(isTest()).toBe(true);
    });

    it('should return false for development environment', () => {
      process.env['NODE_ENV'] = 'development';
      expect(isTest()).toBe(false);
    });

    it('should return false for staging environment', () => {
      process.env['NODE_ENV'] = 'staging';
      expect(isTest()).toBe(false);
    });

    it('should return false for production environment', () => {
      process.env['NODE_ENV'] = 'production';
      expect(isTest()).toBe(false);
    });
  });
});
