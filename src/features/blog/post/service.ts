import { GenericService } from 'src/features/generic/generic.service';
import { BadRequestException, Injectable } from '@nestjs/common';
import { IEntity } from './interfaces/interface';
import { CreateDto } from './dto/create.dto';
import { UpdateDto } from './dto/update.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/features/upload/upload.service';

@Injectable()
export class PostService extends GenericService<
  CreateDto,
  UpdateDto,
  IEntity
> {
  constructor(
    protected prisma: PrismaService,
    protected uploadService: UploadService,
  ) {
    super(prisma, uploadService);
  }

  /**
   * Cria relações de tags para um post
   */
  async createPostTags(tagRelations: { postId: number; tagId: number }[]) {
    return this.prisma.blog_PostTag.createMany({
      data: tagRelations,
      skipDuplicates: true,
    });
  }

  /**
   * Atualiza tags de um post (remove antigas e cria novas)
   */
  async updatePostTags(postId: number, tagIds: number[]) {
    // Remove todas as tags existentes
    await this.prisma.blog_PostTag.deleteMany({
      where: { postId },
    });

    // Cria as novas relações
    if (tagIds && tagIds.length > 0) {
      const tagRelations = tagIds.map((tagId) => ({
        postId,
        tagId: Number(tagId),
      }));

      await this.prisma.blog_PostTag.createMany({
        data: tagRelations,
        skipDuplicates: true,
      });
    }
  }

  /**
   * Publica um post (status = published)
   */
  async publish(postId: number) {
    return this.prisma.blog_Post.update({
      where: { id: Number(postId) },
      data: {
        status: 'published',
        publishedAt: new Date(),
        inactiveAt: null,
      },
    });
  }

  /**
   * Arquiva um post (status = archived)
   */
  async archive(postId: number) {
    return this.prisma.blog_Post.update({
      where: { id: Number(postId) },
      data: {
        status: 'archived',
        inactiveAt: new Date(),
      },
    });
  }

  /**
   * Volta para rascunho (status = draft)
   */
  async toDraft(postId: number) {
    return this.prisma.blog_Post.update({
      where: { id: Number(postId) },
      data: {
        status: 'draft',
        inactiveAt: null,
      },
    });
  }
}
